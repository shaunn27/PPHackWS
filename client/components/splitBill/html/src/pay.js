/**
 * Split the Bill (friend's pay page).
 *
 * Opened from the link the host shared. Shows this person's exact share and
 * a PayPal button. The server creates the order for the STORED share (the
 * browser never sends an amount), with the host's PayPal account as payee,
 * and marks the share paid as soon as PayPal captures it.
 *
 * A friend who paid another way (cash, bank transfer...) can say "I've
 * paid" instead. That only flags the share for the host: it counts as paid
 * once the host confirms it, and this page updates when they do.
 */

const CLAIM_POLL_INTERVAL_MS = 5000;
const METHOD_LABELS = {
  cash: "cash",
  bank_transfer: "bank transfer",
  other_app: "another app",
  other: "another way",
};

const params = new URLSearchParams(location.search);
const splitId = params.get("split");
const payToken = params.get("token");
const apiBase = `/api/splits/${encodeURIComponent(splitId ?? "")}/pay/${encodeURIComponent(payToken ?? "")}`;

const $ = (selector) => document.querySelector(selector);

let view;
let claimPollTimer;
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
  updateClaimUi();
}

/** Shows the "Paid another way?" form, the waiting card, or the rejection notice. */
function updateClaimUi() {
  const claimed = view.status === "claimed";
  for (const selector of ["#rejected-host", "#claimed-host", "#claim-host"]) {
    $(selector).textContent = view.hostName;
  }

  $("#claimed-notice").hidden = !claimed;
  $("#other-way").hidden = claimed;
  $("#rejected-notice").hidden = claimed || !view.claimRejectedAt;

  if (claimed) {
    const method = METHOD_LABELS[view.claim?.method] ?? "another way";
    $("#claimed-detail").textContent = view.claim?.note
      ? `You said you paid by ${method}: “${view.claim.note}”`
      : `You said you paid by ${method}.`;
    startClaimPolling();
  } else {
    stopClaimPolling();
  }
}

$("#claim-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("#claim-button");
  button.disabled = true;
  try {
    const method = new FormData(event.target).get("method");
    const note = $("#claim-note").value.trim();
    await postJson(`${apiBase}/claim`, { method, ...(note && { note }) });
    view = await getJson(apiBase);
    $("#other-way").open = false;
    clearAlert();
    updateClaimUi();
  } catch (error) {
    renderAlert({ type: "danger", message: error.message });
  } finally {
    button.disabled = false;
  }
});

/** While waiting for the host, check every few seconds whether they confirmed. */
function startClaimPolling() {
  if (claimPollTimer) return;
  claimPollTimer = setInterval(async () => {
    try {
      view = await getJson(apiBase);
      if (view.status === "paid") {
        stopClaimPolling();
        showPaid();
      } else {
        updateClaimUi();
      }
    } catch (error) {
      console.error(error);
    }
  }, CLAIM_POLL_INTERVAL_MS);
}

function stopClaimPolling() {
  clearInterval(claimPollTimer);
  claimPollTimer = undefined;
}

function showPaid() {
  clearAlert();
  $("#loading").hidden = true;
  $("#share-section").hidden = true;
  $("#paid-section").hidden = false;
  $("#paid-title").textContent = "You're all square ✓";
  const amount = money(view.share.total, view.currencyCode);
  if (view.paidVia === "other") {
    const method = METHOD_LABELS[view.claim?.method];
    $("#paid-detail").textContent = method
      ? `${view.hostName} confirmed your ${method} payment of ${amount} for ${view.merchantName}.`
      : `${view.hostName} marked your ${amount} share of ${view.merchantName} as paid.`;
  } else {
    $("#paid-detail").textContent =
      `You paid ${view.hostName} back ${amount} for ${view.merchantName} with PayPal.`;
  }
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
  // a friend who said "I've paid" can still change their mind and use PayPal
  if (!view || (view.status !== "pending" && view.status !== "claimed")) return;

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
            stopClaimPolling();
            view.status = "paid";
            view.paidVia = "paypal";
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
