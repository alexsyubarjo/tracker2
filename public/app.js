const form = document.querySelector("#create-form");
const linksEl = document.querySelector("#links");
const activityEl = document.querySelector("#activity");
const activityCaption = document.querySelector("#activity-caption");
const formMessage = document.querySelector("#form-message");
const refreshButton = document.querySelector("#refresh");

let selectedLinkId = null;

function fmtDate(value) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  }[char]));
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Request failed");
  return payload;
}

async function copyText(text, button) {
  await navigator.clipboard.writeText(text);
  const old = button.textContent;
  button.textContent = "Copied";
  setTimeout(() => {
    button.textContent = old;
  }, 1200);
}

function renderLinks(links) {
  if (!links.length) {
    linksEl.innerHTML = '<div class="empty-state">No links yet.</div>';
    return;
  }

  linksEl.innerHTML = links.map((link) => `
    <article class="link-card ${link.id === selectedLinkId ? "selected" : ""}">
      <button class="link-main" data-open="${escapeHtml(link.id)}" type="button">
        <span>
          <strong>${escapeHtml(link.title)}</strong>
          <small>${escapeHtml(link.destinationUrl)}</small>
        </span>
        <span class="pill">${link.clickCount} clicks</span>
      </button>
      <div class="copy-row">
        <input value="${escapeHtml(link.trackingUrl)}" readonly aria-label="Tracking URL for ${escapeHtml(link.title)}">
        <button data-copy="${escapeHtml(link.trackingUrl)}" type="button">Copy</button>
      </div>
    </article>
  `).join("");
}

function renderActivity(link, clicks) {
  activityCaption.textContent = `${link.title} · ${clicks.length} total opens`;

  if (!clicks.length) {
    activityEl.className = "activity empty-state";
    activityEl.textContent = "No clicks recorded for this link yet.";
    return;
  }

  activityEl.className = "activity";
  activityEl.innerHTML = clicks.map((click) => {
    const hasLocation = click.preciseLocation && click.locationPermission === "granted";
    const accuracy = Number.isFinite(Number(click.preciseLocation?.accuracyMeters))
      ? ` · ±${Math.round(Number(click.preciseLocation.accuracyMeters))}m`
      : "";
    const location = hasLocation
      ? `<a href="https://www.google.com/maps?q=${click.preciseLocation.latitude},${click.preciseLocation.longitude}" target="_blank" rel="noreferrer">View map</a>
         <span>${Number(click.preciseLocation.latitude).toFixed(5)}, ${Number(click.preciseLocation.longitude).toFixed(5)}${accuracy}</span>`
      : `<span>${click.locationPermission === "declined" ? "Visitor declined GPS location" : "GPS location not requested"}</span>`;

    return `
      <article class="activity-row">
        <div>
          <strong>${fmtDate(click.createdAt)}</strong>
          <small>${escapeHtml(click.userAgent)}</small>
        </div>
        <dl>
          <div><dt>Language</dt><dd>${escapeHtml(click.acceptLanguage)}</dd></div>
          <div><dt>Timezone</dt><dd>${escapeHtml(click.timezone)}</dd></div>
          <div><dt>Screen</dt><dd>${escapeHtml(click.screen)}</dd></div>
          <div><dt>GPS location</dt><dd>${location}</dd></div>
        </dl>
      </article>
    `;
  }).join("");
}

async function loadLinks() {
  const { links } = await requestJson("/api/links");
  renderLinks(links);
}

async function loadActivity(linkId) {
  selectedLinkId = linkId;
  const { link, clicks } = await requestJson(`/api/links/${linkId}/clicks`);
  await loadLinks();
  renderActivity(link, clicks);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  formMessage.textContent = "Creating link...";

  try {
    const formData = new FormData(form);
    const { link } = await requestJson("/api/links", {
      method: "POST",
      body: JSON.stringify(Object.fromEntries(formData.entries()))
    });
    form.reset();
    formMessage.textContent = "Tracking link created.";
    selectedLinkId = link.id;
    await loadActivity(link.id);
  } catch (error) {
    formMessage.textContent = error.message;
  }
});

linksEl.addEventListener("click", async (event) => {
  const openButton = event.target.closest("[data-open]");
  const copyButton = event.target.closest("[data-copy]");

  if (openButton) {
    await loadActivity(openButton.dataset.open);
  }

  if (copyButton) {
    await copyText(copyButton.dataset.copy, copyButton);
  }
});

refreshButton.addEventListener("click", loadLinks);
loadLinks().catch((error) => {
  linksEl.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
});
