/**
 * Split the Bill (friend's pay page).
 *
 * Opened from the link the host shared. Shows this person's exact share and
 * a PayPal button. The server creates the order for the STORED share (the
 * browser never sends an amount), with the host's PayPal account as payee,
 * and marks the share paid as soon as PayPal captures it.
 */

const params = new URLSearchParams(location.search);
const splitId = params.get("split");
const payToken = params.get("token");
const apiBase = `/api/splits/${encodeURIComponent(splitId ?? "")}/pay/${encodeURIComponent(payToken ?? "")}`;

const $ = (selector) => document.querySelector(selector);

let view;
const viewReady = loadView();

function money(amount, currencyCode) {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currencyCode,
    }).format(Number(amount));
  } catch {
    return `${amount} ${currencyCode}`;
  }
}

async function loadView() {
  if (!splitId || !payToken) {
    showError("This pay link is incomplete. Ask your friend to send it again.");
    return;
  }
  try {
    view = await getJson(apiBase);
    render();
  } catch (error) {
    showError(`Couldn't load this pay link: ${error.message}.`);
  }
}

function render() {
  $("#loading").hidden = true;
  const { share, currencyCode } = view;

  if (view.status === "paid") {
    showPaid();
    return;
  }
  if (view.status === "host") {
    $("#paid-section").hidden = false;
    $("#paid-title").textContent = "Nothing to pay";
    $("#paid-detail").textContent = share.isHost
      ? "This is your own share: you already paid the restaurant."
      : "Your share of this bill is 0.00.";
    return;
  }

  $("#share-section").hidden = false;
  $("#share-context").textContent =
    `${view.hostName} paid ${money(view.receiptTotal, currencyCode)} at ${view.merchantName}${view.date ? ` on ${view.date}` : ""}, split ${view.peopleCount} ways.`;
  $("#share-title").textContent = `Hi ${share.name}, here's your share`;
  $("#share-total").textContent = money(share.total, currencyCode);
  $("#host-name-2").textContent = view.hostName;

  const rows = [
    ...share.items.map((item) => [
      item.sharedWith > 1
        ? `${item.name} (shared by ${item.sharedWith})`
        : item.name,
      money(item.share, currencyCode),
    ]),
    ...(Number(share.charges) > 0
      ? [["Your share of tax & service", money(share.charges, currencyCode)]]
      : []),
    ...(Number(share.discounts) > 0
      ? [
          [
            "Your share of discounts",
            `−${money(share.discounts, currencyCode)}`,
          ],
        ]
      : []),
  ];
  if (share.items.length === 0) {
    rows.unshift([
      `Equal share of ${view.peopleCount}`,
      money(share.total, currencyCode),
    ]);
    $("#share-explainer").hidden = true;
  }

  $("#share-breakdown").replaceChildren(
    ...rows.map(([label, amount]) => {
      const row = document.createElement("tr");
      const labelCell = document.createElement("td");
      labelCell.textContent = label;
      const amountCell = document.createElement("td");
      amountCell.className = "money";
      amountCell.textContent = amount;
      row.append(labelCell, amountCell);
      return row;
    }),
  );
}

function showPaid() {
  clearAlert();
  $("#loading").hidden = true;
  $("#share-section").hidden = true;
  $("#paid-section").hidden = false;
  $("#paid-title").textContent = "You're all square ✓";
  $("#paid-detail").textContent =
    `You paid ${view.hostName} back ${money(view.share.total, view.currencyCode)} for ${view.merchantName}.`;
}

function showError(message) {
  $("#loading").hidden = true;
  renderAlert({ type: "danger", message });
}

/* ######################################################################
 * PayPal (invoked by the SDK script tag's onload)
 * ###################################################################### */

async function onPayPalWebSdkLoaded() {
  await viewReady;
  if (!view || view.status !== "pending") return;

  try {
    const { clientId } = await getJson(
      "/paypal-api/auth/browser-safe-client-id",
    );
    const sdkInstance = await window.paypal.createInstance({
      clientId,
      components: ["paypal-payments"],
      pageType: "checkout",
    });

    const session = sdkInstance.createPayPalOneTimePaymentSession({
      async onApprove({ orderId }) {
        try {
          const result = await postJson(`${apiBase}/capture`, { orderId });
          if (result.status === "COMPLETED") {
            view.status = "paid";
            showPaid();
          }
        } catch (error) {
          renderAlert({ type: "danger", message: error.message });
        }
      },
      onCancel() {
        // a late cancel event must not contradict a share that's already paid
        if (view.status === "paid") return;
        renderAlert({
          type: "warning",
          message: "Payment cancelled. Nothing was charged.",
        });
      },
      onError(error) {
        console.error(error);
        renderAlert({
          type: "danger",
          message: `PayPal error: ${error.message}`,
        });
      },
    });

    const button = $("#paypal-button");
    button.removeAttribute("hidden");
    button.addEventListener("click", async () => {
      try {
        // do not await before start(): it would break the PayPal popup
        const orderPromise = postJson(`${apiBase}/create-order`, {}).then(
          ({ id }) => ({ orderId: id }),
        );
        await session.start({ presentationMode: "auto" }, orderPromise);
      } catch (error) {
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
 * Helpers
 * ###################################################################### */

async function getJson(url) {
  return readJson(await fetch(url));
}

async function postJson(url, body) {
  return readJson(
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function readJson(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      String(
        data.errorDescription ?? data.message ?? data.error ?? response.status,
      ).replace(/[.\s]+$/, ""),
    );
  }
  return data;
}

function renderAlert({ type, message }) {
  const alertElement = $("alert-component");
  alertElement.setAttribute("type", type);
  alertElement.innerText = message;
  alertElement.hidden = false;
}

function clearAlert() {
  $("alert-component").hidden = true;
}
