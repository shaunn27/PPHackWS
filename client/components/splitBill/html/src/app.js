/**
 * Split the Bill (host page).
 *
 * 1. Snap a receipt; AI reads every line (/ai/extract-receipt).
 * 2. The host checks the lines; the page shows live whether they add up.
 * 3. The host adds friends and taps who had what. Shares are always
 *    calculated on the server (/api/splits/preview), in whole cents, with
 *    tax, service and discounts split in proportion to what each person had.
 * 4. Creating the split gives every friend a PayPal pay link for their exact
 *    share; the money goes straight to the host's PayPal account. This page
 *    then polls and shows who has paid.
 */

const MAX_IMAGE_DIMENSION = 1600;
const POLL_INTERVAL_MS = 4000;
const AMOUNT_PATTERN = /^\d{1,7}(\.\d{1,2})?$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HOST_ID = "host";

const state = {
  receipt: emptyReceipt(),
  friends: [],
  nextFriendNumber: 1,
  mode: "itemized",
  previewTimer: undefined,
  previewOk: false,
  pollTimer: undefined,
  hostToken: undefined,
  hostActionInFlight: false,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => document.querySelectorAll(selector);

/** Small DOM builder that only ever sets text, never HTML. */
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "className") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (value !== undefined && value !== false)
      node.setAttribute(key, value);
  }
  for (const child of [children].flat()) {
    if (child) node.append(child);
  }
  return node;
}

function emptyReceipt() {
  return {
    merchantName: "",
    date: "",
    currencyCode: "USD",
    items: [],
    charges: [],
    discounts: [],
    total: "",
  };
}

/* ######################################################################
 * Money helpers (display only: the server does the real arithmetic)
 * ###################################################################### */

function cents(amount) {
  return AMOUNT_PATTERN.test(String(amount).trim())
    ? Math.round(Number(amount) * 100)
    : undefined;
}

function money(amount, currencyCode = state.receipt.currencyCode) {
  const value = typeof amount === "number" ? amount / 100 : Number(amount);
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currencyCode,
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currencyCode}`;
  }
}

/* ######################################################################
 * Steps
 * ###################################################################### */

const STEPS = ["capture", "receipt", "people", "collect"];

function showStep(step) {
  const index = STEPS.indexOf(step);
  for (const item of $$(".steps li")) {
    const itemIndex = STEPS.indexOf(item.dataset.step);
    item.classList.toggle("active", itemIndex === index);
    item.classList.toggle("complete", itemIndex < index);
  }
  $("#capture-section").hidden = step !== "capture";
  $("#receipt-section").hidden = step !== "receipt";
  $("#people-section").hidden = step !== "people";
  $("#collect-section").hidden = step !== "collect";
  window.scrollTo({ top: 0, behavior: "smooth" });
}

for (const button of $$("[data-restart]")) {
  button.addEventListener("click", () => {
    stopPolling();
    history.replaceState(null, "", location.pathname);
    state.receipt = emptyReceipt();
    state.friends = [];
    state.nextFriendNumber = 1;
    clearAlert();
    showStep("capture");
  });
}

/* ######################################################################
 * Step 1: capture
 * ###################################################################### */

$("#file-input").addEventListener("change", (event) => {
  const [file] = event.target.files;
  if (file) processImage(file);
  event.target.value = "";
});

for (const sample of $$(".sample")) {
  sample.addEventListener("click", () => processImage(sample.dataset.src));
}

const dropzone = $("#dropzone");
dropzone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropzone.classList.add("dragging");
});
dropzone.addEventListener("dragleave", () =>
  dropzone.classList.remove("dragging"),
);
dropzone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropzone.classList.remove("dragging");
  const [file] = event.dataTransfer.files;
  if (file) processImage(file);
});

$("#manual-entry").addEventListener("click", () => {
  state.receipt = emptyReceipt();
  state.receipt.items = [{ name: "", lineTotal: "", owners: new Set() }];
  $(".preview").hidden = true;
  showStep("receipt");
  $("#extracting").hidden = true;
  renderReceiptForm({ warnings: [], provider: "" });
});

async function processImage(source) {
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

  showStep("receipt");
  $(".preview").hidden = false;
  $("#receipt-preview").src = dataUrl;
  $("#extracting").hidden = false;
  $("#receipt-form").hidden = true;

  try {
    const { receipt, warnings, provider } = await postJson(
      "/ai/extract-receipt",
      { image: dataUrl },
    );
    state.receipt = {
      merchantName: receipt.merchantName ?? "",
      date: receipt.date ?? "",
      currencyCode: receipt.currencyCode ?? "USD",
      items: receipt.items.map(({ name, lineTotal }) => ({
        name,
        lineTotal,
        owners: new Set(),
      })),
      charges: receipt.charges.map(({ label, amount }) => ({ label, amount })),
      discounts: receipt.discounts.map(({ label, amount }) => ({
        label,
        amount,
      })),
      total: receipt.total ?? "",
    };
    renderReceiptForm({ warnings, provider });
  } catch (error) {
    console.error(error);
    renderAlert({
      type: "danger",
      message: `AI couldn't read the receipt: ${error.message}. You can type it in yourself.`,
    });
    state.receipt = emptyReceipt();
    state.receipt.items = [{ name: "", lineTotal: "", owners: new Set() }];
    renderReceiptForm({ warnings: [], provider: "" });
  } finally {
    $("#extracting").hidden = true;
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
    if (typeof source !== "string") URL.revokeObjectURL(url);
  }
}

/* ######################################################################
 * Step 2: check the receipt
 * ###################################################################### */

const LINE_KINDS = {
  items: { nameKey: "name", amountKey: "lineTotal", placeholder: "Item" },
  charges: {
    nameKey: "label",
    amountKey: "amount",
    placeholder: "e.g. Tax 6%",
  },
  discounts: {
    nameKey: "label",
    amountKey: "amount",
    placeholder: "e.g. Promo",
  },
};

function renderReceiptForm({ warnings, provider }) {
  $("#provider-label").textContent = provider ? `(${provider})` : "";
  const list = $("#receipt-warnings");
  list.replaceChildren(
    ...warnings.map(({ message }) => el("li", { text: message })),
  );
  list.hidden = warnings.length === 0;

  $("#merchant-name").value = state.receipt.merchantName;
  $("#receipt-date").value = state.receipt.date;
  $("#currency").value = [...$("#currency").options].some(
    ({ value }) => value === state.receipt.currencyCode,
  )
    ? state.receipt.currencyCode
    : "USD";
  state.receipt.currencyCode = $("#currency").value;
  $("#total").value = state.receipt.total;

  for (const kind of Object.keys(LINE_KINDS)) renderLines(kind);
  $("#receipt-form").hidden = false;
  updateReconcile();
}

function renderLines(kind) {
  const { nameKey, amountKey, placeholder } = LINE_KINDS[kind];
  const lines = state.receipt[kind];
  $(`#${kind}`).replaceChildren(
    ...lines.map((line, index) =>
      el("div", { className: "line" }, [
        el("input", {
          value: line[nameKey],
          placeholder,
          "aria-label": `${placeholder} name`,
          oninput: (event) => {
            line[nameKey] = event.target.value;
            updateReconcile();
          },
        }),
        el("input", {
          className: "amount",
          value: line[amountKey],
          placeholder: "0.00",
          inputmode: "decimal",
          "aria-label": "Amount",
          oninput: (event) => {
            line[amountKey] = event.target.value.trim();
            updateReconcile();
          },
        }),
        el("button", {
          type: "button",
          className: "icon-button",
          "aria-label": "Remove",
          text: "×",
          onclick: () => {
            lines.splice(index, 1);
            renderLines(kind);
            updateReconcile();
          },
        }),
      ]),
    ),
  );
}

for (const button of $$("[data-add]")) {
  button.addEventListener("click", () => {
    const kind = button.dataset.add;
    const { nameKey, amountKey } = LINE_KINDS[kind];
    const line = { [nameKey]: "", [amountKey]: "" };
    if (kind === "items") line.owners = new Set();
    state.receipt[kind].push(line);
    renderLines(kind);
    updateReconcile();
    $(`#${kind} .line:last-child input`).focus();
  });
}

$("#merchant-name").addEventListener("input", (event) => {
  state.receipt.merchantName = event.target.value;
  updateReconcile();
});
$("#receipt-date").addEventListener("input", (event) => {
  state.receipt.date = event.target.value;
});
$("#currency").addEventListener("change", (event) => {
  state.receipt.currencyCode = event.target.value;
  updateReconcile();
});
$("#total").addEventListener("input", (event) => {
  state.receipt.total = event.target.value.trim();
  updateReconcile();
});

/** Live check: do items + charges - discounts equal the total? */
function updateReconcile() {
  const { receipt } = state;
  const box = $("#reconcile");
  const sum = (lines, key) =>
    lines.reduce(
      (total, line) =>
        total === undefined || cents(line[key]) === undefined
          ? undefined
          : total + cents(line[key]),
      0,
    );

  const itemsCents = sum(receipt.items, "lineTotal");
  const chargesCents = sum(receipt.charges, "amount");
  const discountsCents = sum(receipt.discounts, "amount");
  const totalCents = cents(receipt.total);
  const namesOk =
    receipt.merchantName.trim() &&
    receipt.items.length > 0 &&
    [...receipt.items].every((item) => item.name.trim()) &&
    [...receipt.charges, ...receipt.discounts].every((line) =>
      line.label.trim(),
    );

  let ok = false;
  if (
    [itemsCents, chargesCents, discountsCents, totalCents].includes(undefined)
  ) {
    box.textContent = "Every amount needs to look like 12.50.";
  } else if (receipt.items.length === 0) {
    box.textContent = "Add at least one item.";
  } else {
    const computed = itemsCents + chargesCents - discountsCents;
    if (computed === totalCents) {
      ok = Boolean(namesOk);
      box.textContent = ok
        ? `✓ Adds up: items ${money(itemsCents)} + charges ${money(chargesCents)} − discounts ${money(discountsCents)} = ${money(totalCents)}`
        : "Give the merchant and every line a name.";
    } else {
      box.textContent = `Doesn't add up yet: the lines come to ${money(computed)}, but the total is ${money(totalCents)} (off by ${money(totalCents - computed)}).`;
    }
  }
  box.className = `reconcile ${ok ? "ok" : "off"}`;
  $("#to-people").disabled = !ok;
}

$("#to-people").addEventListener("click", () => {
  if (state.friends.length === 0) addFriend();
  if (state.friends.length === 1) addFriend();
  showStep("people");
  renderFriends();
  renderAssignments();
  schedulePreview();
});

/* ######################################################################
 * Step 3: people and assignment
 * ###################################################################### */

function addFriend() {
  state.friends.push({ id: `f${state.nextFriendNumber++}`, name: "" });
}

$("#add-friend").addEventListener("click", () => {
  addFriend();
  renderFriends();
  renderAssignments();
  schedulePreview();
  $("#friends .line:last-child input").focus();
});

function renderFriends() {
  $("#friends").replaceChildren(
    ...state.friends.map((friend, index) =>
      el(
        "div",
        { className: "line", style: "grid-template-columns: 1fr auto" },
        [
          el("input", {
            value: friend.name,
            placeholder: `Friend ${index + 1}'s name`,
            "aria-label": `Friend ${index + 1}'s name`,
            oninput: (event) => {
              friend.name = event.target.value;
              renderAssignments();
              schedulePreview();
            },
          }),
          el("button", {
            type: "button",
            className: "icon-button",
            "aria-label": "Remove friend",
            text: "×",
            onclick: () => {
              state.friends.splice(index, 1);
              for (const item of state.receipt.items)
                item.owners.delete(friend.id);
              renderFriends();
              renderAssignments();
              schedulePreview();
            },
          }),
        ],
      ),
    ),
  );
}

function people() {
  return [
    { id: HOST_ID, name: $("#host-name").value.trim() || "You" },
    ...state.friends.map((friend, index) => ({
      id: friend.id,
      name: friend.name.trim() || `Friend ${index + 1}`,
    })),
  ];
}

for (const button of $$(".mode-toggle button")) {
  button.addEventListener("click", () => {
    state.mode = button.dataset.mode;
    for (const other of $$(".mode-toggle button")) {
      other.classList.toggle("selected", other === button);
    }
    renderAssignments();
    schedulePreview();
  });
}

function renderAssignments() {
  const container = $("#assignments");
  if (state.mode === "equal") {
    $("#mode-help").textContent =
      "Everyone pays the same share of the total. Any odd cent goes to you.";
    container.replaceChildren();
    return;
  }
  $("#mode-help").textContent =
    "Tap who had each item. Tap several people for something you shared. Tax, service and discounts are split in proportion to what each person had.";

  const everyone = people();
  container.replaceChildren(
    ...state.receipt.items.map((item) => {
      const allOn = everyone.every(({ id }) => item.owners.has(id));
      return el(
        "div",
        {
          className: `assign-item ${item.owners.size === 0 ? "unassigned" : ""}`,
        },
        [
          el("div", { className: "assign-item-head" }, [
            el("span", { text: item.name }),
            el("span", { text: money(cents(item.lineTotal) ?? 0) }),
          ]),
          el("div", { className: "chips" }, [
            ...everyone.map((person) =>
              el("button", {
                type: "button",
                className: `chip ${item.owners.has(person.id) ? "on" : ""}`,
                "aria-pressed": String(item.owners.has(person.id)),
                text: person.name,
                onclick: () => {
                  if (item.owners.has(person.id)) item.owners.delete(person.id);
                  else item.owners.add(person.id);
                  renderAssignments();
                  schedulePreview();
                },
              }),
            ),
            el("button", {
              type: "button",
              className: `chip everyone ${allOn ? "on" : ""}`,
              text: "Everyone",
              onclick: () => {
                item.owners = allOn
                  ? new Set()
                  : new Set(everyone.map(({ id }) => id));
                renderAssignments();
                schedulePreview();
              },
            }),
          ]),
        ],
      );
    }),
  );
}

$("#host-name").addEventListener("input", () => {
  renderAssignments();
  schedulePreview();
});
$("#host-email").addEventListener("input", updateCreateButton);

function splitRequestBody() {
  const { receipt } = state;
  return {
    receipt: {
      merchantName: receipt.merchantName.trim(),
      ...(receipt.date.trim() && { date: receipt.date.trim() }),
      currencyCode: receipt.currencyCode,
      items: receipt.items.map(({ name, lineTotal }) => ({
        name: name.trim(),
        lineTotal,
      })),
      charges: receipt.charges.map(({ label, amount }) => ({
        label: label.trim(),
        amount,
      })),
      discounts: receipt.discounts.map(({ label, amount }) => ({
        label: label.trim(),
        amount,
      })),
      total: receipt.total,
    },
    host: {
      id: HOST_ID,
      name: $("#host-name").value.trim() || "You",
      ...(EMAIL_PATTERN.test($("#host-email").value.trim()) && {
        email: $("#host-email").value.trim(),
      }),
    },
    friends: people()
      .slice(1)
      .map(({ id, name }) => ({ id, name })),
    mode: state.mode,
    ...(state.mode === "itemized" && {
      assignments: Object.fromEntries(
        receipt.items.map((item, index) => [String(index), [...item.owners]]),
      ),
    }),
  };
}

function schedulePreview() {
  state.previewOk = false;
  updateCreateButton();
  clearTimeout(state.previewTimer);
  state.previewTimer = setTimeout(runPreview, 300);
}

async function runPreview() {
  const errorBox = $("#preview-error");
  const body = $("#preview-body");
  try {
    const { shares, currencyCode } = await postJson(
      "/api/splits/preview",
      splitRequestBody(),
    );
    errorBox.textContent = "";
    body.replaceChildren(
      ...shares.map((share) =>
        el("tr", {}, [
          el("td", {}, [
            el("strong", {
              text: share.isHost ? `${share.name} (you)` : share.name,
            }),
            el("div", {
              className: "breakdown",
              text: describeShare(share, currencyCode),
            }),
          ]),
          el("td", {
            className: "money",
            text: money(share.total, currencyCode),
          }),
        ]),
      ),
    );
    state.previewOk = true;
  } catch (error) {
    errorBox.textContent = error.message;
    body.replaceChildren();
    state.previewOk = false;
  }
  updateCreateButton();
}

function describeShare(share, currencyCode) {
  if (state.mode === "equal" || share.items.length === 0) {
    return share.items.length === 0 && state.mode === "itemized"
      ? "Nothing assigned"
      : "Equal share";
  }
  const items = share.items
    .map(({ name, sharedWith }) =>
      sharedWith > 1 ? `${name} (1/${sharedWith})` : name,
    )
    .join(", ");
  const parts = [`${items}`];
  if (Number(share.charges) > 0)
    parts.push(`+ ${money(share.charges, currencyCode)} tax & service`);
  if (Number(share.discounts) > 0)
    parts.push(`− ${money(share.discounts, currencyCode)} discount`);
  return parts.join(" ");
}

function updateCreateButton() {
  const emailOk = EMAIL_PATTERN.test($("#host-email").value.trim());
  const namesOk = state.friends.every((friend) => friend.name.trim());
  $("#create-split").disabled = !(state.previewOk && emailOk && namesOk);
}

$("#back-to-receipt").addEventListener("click", () => showStep("receipt"));

$("#create-split").addEventListener("click", async () => {
  const button = $("#create-split");
  button.disabled = true;
  try {
    const split = await postJson("/api/splits", splitRequestBody());
    history.replaceState(null, "", split.hostPath);
    showDashboard(split);
    startPolling(split.id, split.hostToken);
  } catch (error) {
    renderAlert({ type: "danger", message: error.message });
    button.disabled = false;
  }
});

/* ######################################################################
 * Step 4: collect
 * ###################################################################### */

const CLAIM_METHOD_LABELS = {
  cash: "cash",
  bank_transfer: "bank transfer",
  other_app: "another app",
  other: "another way",
};

function showDashboard(split) {
  showStep("collect");
  const currency = split.currencyCode;
  const friends = split.participants.filter((p) => !p.isHost);
  const owedCents = cents(split.owed) ?? 0;
  const collectedCents = cents(split.collected) ?? 0;
  const otherCents = cents(split.collectedOther) ?? 0;
  const claimedCount = friends.filter((p) => p.status === "claimed").length;
  const allPaid = friends.every(
    (p) => p.status !== "pending" && p.status !== "claimed",
  );

  $("#collect-title").textContent = allPaid
    ? "Everyone has paid you back 🎉"
    : "Collect your money";
  $("#collect-subtitle").textContent =
    `${split.merchantName}${split.date ? ` · ${split.date}` : ""} · total ${money(split.total, currency)} · paid to ${split.hostEmail}`;
  $("#progress-bar").style.width = owedCents
    ? `${Math.round((collectedCents / owedCents) * 100)}%`
    : "100%";

  let summary = `${money(collectedCents, currency)} of ${money(owedCents, currency)} collected`;
  if (otherCents > 0) {
    summary += ` (${money(split.collectedViaPayPal, currency)} via PayPal, ${money(otherCents, currency)} confirmed by you)`;
  }
  if (claimedCount > 0) {
    summary += ` · ${claimedCount} waiting for you to confirm`;
  }
  $("#collect-summary").textContent = summary;

  $("#shares-body").replaceChildren(
    ...split.participants.map((participant) =>
      shareRow(split, participant, currency),
    ),
  );

  if (allPaid) stopPolling();
}

function shareRow(split, participant, currency) {
  const payUrl =
    participant.payPath && new URL(participant.payPath, location.origin).href;
  const message = `Hi ${participant.name}! Your share of ${split.merchantName} is ${money(participant.total, currency)}. Pay me back with PayPal: ${payUrl}`;
  const claim = participant.claim;
  const statusLabel = {
    host: participant.isHost ? "you" : "nothing owed",
    pending: "waiting",
    claimed: "says paid",
    paid:
      participant.paidVia === "paypal" ? "paid · PayPal" : "paid · confirmed",
  }[participant.status];

  return el("tr", {}, [
    el("td", {}, [
      el("strong", { text: participant.name }),
      " ",
      el("span", {
        className: `badge ${participant.status}`,
        text: statusLabel,
      }),
      el("div", {
        className: "breakdown",
        text: participant.items.length
          ? participant.items.map(({ name }) => name).join(", ")
          : "Equal share",
      }),

      // the friend says they paid outside PayPal: the host confirms or rejects
      participant.status === "claimed" &&
        el("div", { className: "claim-box" }, [
          el("div", {
            text: `Says they paid you by ${CLAIM_METHOD_LABELS[claim?.method] ?? "another way"}.`,
          }),
          claim?.note &&
            el("div", { className: "claim-note", text: `“${claim.note}”` }),
          el("div", { className: "share-actions" }, [
            hostActionButton(
              split,
              participant,
              "confirm",
              "Confirm received",
              {
                primary: true,
              },
            ),
            hostActionButton(split, participant, "reject", "Not received"),
          ]),
        ]),

      participant.status === "pending" &&
        el("div", { className: "share-actions" }, [
          el("button", {
            type: "button",
            className: "small-button",
            text: "Copy link",
            onclick: async (event) => {
              try {
                await navigator.clipboard.writeText(message);
                event.target.textContent = "Copied ✓";
              } catch {
                window.prompt("Copy this message:", message);
              }
            },
          }),
          el("a", {
            className: "small-button",
            href: `https://wa.me/?text=${encodeURIComponent(message)}`,
            target: "_blank",
            rel: "noopener",
            text: "Share on WhatsApp",
          }),
          el("a", {
            className: "small-button",
            href: payUrl,
            target: "_blank",
            rel: "noopener",
            text: "Open pay page",
          }),
          hostActionButton(split, participant, "confirm", "Mark as paid", {
            confirmText: `Mark ${participant.name} as paid? Only do this once you've received ${money(participant.total, currency)} from them.`,
          }),
        ]),
    ]),
    el("td", {
      className: "money",
      text: money(participant.total, currency),
    }),
  ]);
}

/** "Confirm received", "Not received" and "Mark as paid": need the host token. */
function hostActionButton(split, participant, action, label, options = {}) {
  return el("button", {
    type: "button",
    className: `small-button ${options.primary ? "confirm-button" : ""}`,
    text: label,
    onclick: async (event) => {
      if (options.confirmText && !window.confirm(options.confirmText)) return;
      const button = event.target;
      button.disabled = true;
      state.hostActionInFlight = true;
      try {
        const updated = await postJson(
          `/api/splits/${encodeURIComponent(split.id)}/participants/${encodeURIComponent(participant.participantId)}/${action}`,
          { hostToken: state.hostToken },
        );
        showDashboard(updated);
      } catch (error) {
        renderAlert({ type: "danger", message: error.message });
        button.disabled = false;
      } finally {
        state.hostActionInFlight = false;
      }
    },
  });
}

function startPolling(id, hostToken) {
  stopPolling();
  state.hostToken = hostToken;
  const refresh = async () => {
    // don't redraw the buttons under the host's finger mid-action
    if (state.hostActionInFlight) return;
    try {
      const split = await getJson(
        `/api/splits/${encodeURIComponent(id)}?hostToken=${encodeURIComponent(hostToken)}`,
      );
      showDashboard(split);
    } catch (error) {
      console.error(error);
    }
  };
  state.pollTimer = setInterval(refresh, POLL_INTERVAL_MS);
}

function stopPolling() {
  clearInterval(state.pollTimer);
  state.pollTimer = undefined;
}

/* ######################################################################
 * Start: open an existing split from its host link, or begin a new one
 * ###################################################################### */

(async function start() {
  const params = new URLSearchParams(location.search);
  const id = params.get("split");
  const hostToken = params.get("host");
  if (!id || !hostToken) return;

  try {
    const split = await getJson(
      `/api/splits/${encodeURIComponent(id)}?hostToken=${encodeURIComponent(hostToken)}`,
    );
    showDashboard(split);
    startPolling(id, hostToken);
  } catch (error) {
    renderAlert({
      type: "danger",
      message: `Couldn't open that split: ${error.message}`,
    });
  }
})();

/* ######################################################################
 * Helpers
 * ###################################################################### */

async function getJson(url) {
  const response = await fetch(url);
  return readJson(response);
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return readJson(response);
}

async function readJson(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = String(
      data.errorDescription ?? data.message ?? data.error ?? response.status,
    )
      .replace(/^✖\s*/, "")
      .replace(/\n\s*→.*$/s, "")
      .replace(/[.\s]+$/, "");
    throw new Error(reason);
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

// tap the photo thumbnail to see the whole bill, tap again to shrink it
document.querySelector(".preview img")?.addEventListener("click", (event) => {
  event.target.closest(".preview").classList.toggle("expanded");
});
