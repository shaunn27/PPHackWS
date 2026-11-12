/**
 * Snap & Pay: photo of a bill -> AI extraction -> human review -> PayPal.
 *
 * 1. The user takes a photo of a bill (or picks a sample).
 * 2. The image is shrunk in the browser and sent to /ai/extract-bill, where
 *    an AI vision model reads the payee, amount and reference.
 * 3. The extracted values PREFILL a form. Nothing is paid until the user has
 *    checked them, ticked the confirmation box and approved in PayPal.
 * 4. The server creates an order whose `payee` is the biller's PayPal
 *    account, so the money goes straight to the biller.
 */

const MAX_IMAGE_DIMENSION = 1600;
const KNOWN_PAYEES_STORAGE_KEY = "snapAndPay.knownPayees";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const AMOUNT_PATTERN = /^\d{1,7}(\.\d{1,2})?$/;

const state = {
  maxAmount: 500,
  // the exact values sent to PayPal, kept for the receipt
  pendingPayment: null,
};

const elements = {
  steps: document.querySelectorAll(".steps li"),
  captureSection: document.querySelector("#capture-section"),
  reviewSection: document.querySelector("#review-section"),
  receiptSection: document.querySelector("#receipt-section"),
  dropzone: document.querySelector("#dropzone"),
  fileInput: document.querySelector("#file-input"),
  samples: document.querySelectorAll(".sample"),
  preview: document.querySelector("#bill-preview"),
  extracting: document.querySelector("#extracting"),
  form: document.querySelector("#review-form"),
  providerLabel: document.querySelector("#provider-label"),
  warnings: document.querySelector("#warnings"),
  billerName: document.querySelector("#biller-name"),
  payeeEmail: document.querySelector("#payee-email"),
  payeeStatus: document.querySelector("#payee-status"),
  amount: document.querySelector("#amount"),
  currency: document.querySelector("#currency"),
  reference: document.querySelector("#reference"),
  dueDate: document.querySelector("#due-date"),
  formError: document.querySelector("#form-error"),
  confirmCheck: document.querySelector("#confirm-check"),
  payContainer: document.querySelector("#pay-container"),
  paypalButton: document.querySelector("#paypal-button"),
  startOver: document.querySelector("#start-over"),
  receiptDetails: document.querySelector("#receipt-details"),
  payAnother: document.querySelector("#pay-another"),
};

/* ######################################################################
 * PayPal Web SDK setup (invoked by the SDK script tag's onload)
 * ###################################################################### */

async function onPayPalWebSdkLoaded() {
  try {
    const clientId = await getBrowserSafeClientId();
    const sdkInstance = await window.paypal.createInstance({
      clientId,
      components: ["paypal-payments"],
      pageType: "checkout",
    });

    const paypalPaymentSession = sdkInstance.createPayPalOneTimePaymentSession({
      onApprove: handleApprove,
      onCancel() {
        highlightStep("review");
        renderAlert({
          type: "warning",
          message: "Payment cancelled. Nothing was charged.",
        });
      },
      onError(error) {
        highlightStep("review");
        console.error(error);
        renderAlert({
          type: "danger",
          message: `PayPal error: ${error.message}`,
        });
      },
    });

    elements.paypalButton.removeAttribute("hidden");
    elements.paypalButton.addEventListener("click", async () => {
      // validate synchronously so the popup keeps its transient activation
      const payment = readValidatedPayment();
      if (!payment || !elements.confirmCheck.checked) {
        return;
      }

      try {
        state.pendingPayment = payment;
        highlightStep("pay");
        // do not await createOrder() before start(): it would break the popup
        const createOrderPromise = createBillPaymentOrder(payment);
        await paypalPaymentSession.start(
          { presentationMode: "auto" },
          createOrderPromise,
        );
      } catch (error) {
        highlightStep("review");
        console.error(error);
        renderAlert({ type: "danger", message: error.message });
      }
    });
  } catch (error) {
    console.error(error);
    renderAlert({
      type: "danger",
      message: "Failed to initialize the PayPal Web SDK",
    });
  }
}

/* ######################################################################
 * Step 1: capture the bill
 * ###################################################################### */

elements.fileInput.addEventListener("change", () => {
  const [file] = elements.fileInput.files;
  if (file) {
    processImageSource(file);
  }
  elements.fileInput.value = "";
});

for (const sample of elements.samples) {
  sample.addEventListener("click", () =>
    processImageSource(sample.dataset.src),
  );
}

elements.dropzone.addEventListener("dragover", (event) => {
  event.preventDefault();
  elements.dropzone.classList.add("dragging");
});
elements.dropzone.addEventListener("dragleave", () => {
  elements.dropzone.classList.remove("dragging");
});
elements.dropzone.addEventListener("drop", (event) => {
  event.preventDefault();
  elements.dropzone.classList.remove("dragging");
  const [file] = event.dataTransfer.files;
  if (file) {
    processImageSource(file);
  }
});

/** @param {File | string} source - an uploaded file or a sample image URL */
async function processImageSource(source) {
  clearAlert();
  let dataUrl;
  try {
    dataUrl = await toResizedJpegDataUrl(source);
  } catch (error) {
    console.error(error);
    renderAlert({
      type: "danger",
      message: "Couldn't read that image. Try a JPEG, PNG or WebP photo.",
    });
    return;
  }

  showStep("review");
  elements.preview.src = dataUrl;
  elements.extracting.hidden = false;
  elements.form.hidden = true;

  try {
    const result = await extractBill(dataUrl);
    fillReviewForm(result);
  } catch (error) {
    console.error(error);
    renderAlert({ type: "danger", message: error.message });
    // fall back to an empty form the user can fill in by hand
    fillReviewForm({ bill: {}, warnings: [], limits: {}, provider: "" });
  } finally {
    elements.extracting.hidden = true;
  }
}

/** Downscale and re-encode in the browser: smaller uploads, no EXIF data. */
async function toResizedJpegDataUrl(source) {
  const url = typeof source === "string" ? source : URL.createObjectURL(source);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();

    const scale = Math.min(
      1,
      MAX_IMAGE_DIMENSION / Math.max(image.naturalWidth, image.naturalHeight),
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(image.naturalWidth * scale);
    canvas.height = Math.round(image.naturalHeight * scale);

    const context = canvas.getContext("2d");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.85);
  } finally {
    if (typeof source !== "string") {
      URL.revokeObjectURL(url);
    }
  }
}

async function extractBill(dataUrl) {
  const response = await fetch("/ai/extract-bill", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: dataUrl }),
  });
  const data = await response.json();

  if (!response.ok) {
    const reason = String(
      data.errorDescription ?? data.error ?? response.status,
    ).replace(/[.\s]+$/, "");
    throw new Error(
      `AI couldn't read the bill: ${reason}. You can fill in the details yourself.`,
    );
  }
  return data;
}

/* ######################################################################
 * Step 2: review
 * ###################################################################### */

function fillReviewForm({ bill, warnings, limits, provider }) {
  state.maxAmount = limits?.maxAmount ?? state.maxAmount;

  setField(elements.billerName, bill.billerName);
  setField(elements.payeeEmail, bill.payeeEmail);
  setField(elements.amount, bill.amount);
  setField(elements.reference, bill.reference);
  setField(elements.dueDate, bill.dueDate);
  if (bill.currencyCode && hasCurrencyOption(bill.currencyCode)) {
    elements.currency.value = bill.currencyCode;
  }

  elements.providerLabel.textContent = provider ? `(${provider})` : "";
  renderWarnings(warnings ?? []);
  elements.confirmCheck.checked = false;
  elements.form.hidden = false;
  updatePayeeStatus();
  updatePayButtonState();
}

function setField(input, value) {
  input.value = value ?? "";
  input.classList.toggle("ai-filled", Boolean(value));
  input.classList.remove("invalid");
}

function hasCurrencyOption(code) {
  return [...elements.currency.options].some(({ value }) => value === code);
}

function renderWarnings(warnings) {
  elements.warnings.replaceChildren(
    ...warnings.map(({ message }) => {
      const item = document.createElement("li");
      item.textContent = message;
      return item;
    }),
  );
  elements.warnings.hidden = warnings.length === 0;
}

// any edit means the user has to re-confirm what they're paying
for (const input of [
  elements.billerName,
  elements.payeeEmail,
  elements.amount,
  elements.currency,
  elements.reference,
]) {
  input.addEventListener("input", () => {
    input.classList.remove("ai-filled");
    elements.confirmCheck.checked = false;
    if (input === elements.payeeEmail) {
      updatePayeeStatus();
    }
    updatePayButtonState();
  });
}

elements.confirmCheck.addEventListener("change", updatePayButtonState);

function updatePayeeStatus() {
  const email = elements.payeeEmail.value.trim().toLowerCase();
  const status = elements.payeeStatus;
  status.className = "field-note";

  if (!EMAIL_PATTERN.test(email)) {
    status.textContent = "";
  } else if (getKnownPayees().includes(email)) {
    status.textContent = "✓ You've paid this payee before";
    status.classList.add("known-payee");
  } else {
    status.textContent =
      "New payee: you've never paid this address. Make sure it's really the biller's.";
    status.classList.add("new-payee");
  }
}

/** Returns the payment to make, or null (and shows why) if the form is invalid. */
function readValidatedPayment() {
  const payment = {
    billerName: elements.billerName.value.trim(),
    payeeEmail: elements.payeeEmail.value.trim(),
    amount: elements.amount.value.trim(),
    currencyCode: elements.currency.value,
    reference: elements.reference.value.trim() || undefined,
  };

  const errors = [];
  const mark = (input, invalid) => input.classList.toggle("invalid", invalid);

  mark(elements.billerName, !payment.billerName);
  if (!payment.billerName) errors.push("Enter the biller's name.");

  const badEmail = !EMAIL_PATTERN.test(payment.payeeEmail);
  mark(elements.payeeEmail, badEmail);
  if (badEmail) errors.push("Enter the biller's PayPal email.");

  const amountValue = Number(payment.amount);
  const badAmount =
    !AMOUNT_PATTERN.test(payment.amount) ||
    amountValue <= 0 ||
    amountValue > state.maxAmount;
  mark(elements.amount, badAmount);
  if (badAmount) {
    errors.push(
      `Enter an amount between 0.01 and ${state.maxAmount.toFixed(2)}.`,
    );
  }

  elements.formError.textContent = errors.join(" ");
  return errors.length === 0 ? payment : null;
}

function updatePayButtonState() {
  const payment = readValidatedPayment();
  const ready = Boolean(payment) && elements.confirmCheck.checked;
  elements.payContainer.classList.toggle("locked", !ready);

  const hint = document.querySelector("#pay-hint");
  hint.textContent = payment
    ? "Tick the box above to unlock payment."
    : "Fix the details above to unlock payment.";
}

elements.startOver.addEventListener("click", resetToCapture);
elements.payAnother.addEventListener("click", resetToCapture);

function resetToCapture() {
  clearAlert();
  elements.form.reset();
  elements.formError.textContent = "";
  showStep("capture");
}

/* ######################################################################
 * Step 3: pay
 * ###################################################################### */

async function createBillPaymentOrder(payment) {
  const response = await fetch(
    "/paypal-api/checkout/orders/create-order-for-bill-payment",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payment),
    },
  );
  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      `Couldn't create the payment: ${data.errorDescription ?? data.message ?? data.name ?? response.status}`,
    );
  }
  return { orderId: data.id };
}

async function handleApprove({ orderId }) {
  const payment = state.pendingPayment;
  try {
    const capture = await postJson(
      `/paypal-api/checkout/orders/${orderId}/capture`,
    );
    if (capture.status !== "COMPLETED") {
      throw new Error(`Payment status: ${capture.status}`);
    }

    const order = await getJson(`/paypal-api/checkout/orders/${orderId}`);
    const captureDetails = order.purchaseUnits?.[0]?.payments?.captures?.[0];

    rememberPayee(payment.payeeEmail);
    renderReceipt({ orderId, payment, captureDetails });
  } catch (error) {
    console.error(error);
    renderAlert({
      type: "danger",
      message: `The payment was approved but couldn't be completed: ${error.message}`,
    });
  }
}

/* ######################################################################
 * Step 4: receipt
 * ###################################################################### */

function renderReceipt({ orderId, payment, captureDetails }) {
  clearAlert();
  const amount = captureDetails?.amount
    ? `${captureDetails.amount.value} ${captureDetails.amount.currencyCode}`
    : `${payment.amount} ${payment.currencyCode}`;

  const rows = [
    ["Paid to", payment.billerName],
    ["PayPal account", payment.payeeEmail],
    ["Amount", amount],
    ["Reference", payment.reference ?? "-"],
    ["Status", captureDetails?.status ?? "COMPLETED"],
    ["Transaction ID", captureDetails?.id ?? "-"],
    ["Order ID", orderId],
  ];

  elements.receiptDetails.replaceChildren(
    ...rows.flatMap(([label, value]) => {
      const term = document.createElement("dt");
      term.textContent = label;
      const detail = document.createElement("dd");
      detail.textContent = value;
      return [term, detail];
    }),
  );
  showStep("done");
}

/* ######################################################################
 * Helpers
 * ###################################################################### */

const STEPS = ["capture", "review", "pay", "done"];

function highlightStep(step) {
  const index = STEPS.indexOf(step);
  for (const item of elements.steps) {
    const itemIndex = STEPS.indexOf(item.dataset.step);
    item.classList.toggle("active", itemIndex === index);
    item.classList.toggle("complete", itemIndex < index);
  }
}

function showStep(step) {
  highlightStep(step);
  elements.captureSection.hidden = step !== "capture";
  elements.reviewSection.hidden = step !== "review";
  elements.receiptSection.hidden = step !== "done";
}

function getKnownPayees() {
  try {
    return JSON.parse(localStorage.getItem(KNOWN_PAYEES_STORAGE_KEY)) ?? [];
  } catch {
    return [];
  }
}

function rememberPayee(email) {
  try {
    const payees = new Set(getKnownPayees());
    payees.add(email.toLowerCase());
    localStorage.setItem(KNOWN_PAYEES_STORAGE_KEY, JSON.stringify([...payees]));
  } catch {
    // storage unavailable (e.g. private browsing): the "new payee" hint just won't remember
  }
}

async function getBrowserSafeClientId() {
  const { clientId } = await getJson("/paypal-api/auth/browser-safe-client-id");
  return clientId;
}

async function getJson(url) {
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.errorDescription ?? data.message ?? response.status);
  }
  return data;
}

async function postJson(url, body = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(
      data.details?.[0]?.description ??
        data.message ??
        data.name ??
        response.status,
    );
  }
  return data;
}

function renderAlert({ type, message }) {
  const alertElement = document.querySelector("alert-component");
  alertElement.setAttribute("type", type);
  alertElement.innerText = message;
  alertElement.hidden = false;
}

function clearAlert() {
  document.querySelector("alert-component").hidden = true;
}
