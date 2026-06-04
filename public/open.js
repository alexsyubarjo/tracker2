const statusEl = document.querySelector("#status");
const shareLocationButton = document.querySelector("#share-location");

const linkId = new URLSearchParams(location.search).get("id") || location.pathname.split("/").filter(Boolean).pop();
let clickId = null;
let destinationUrl = null;

function setStatus(message) {
  statusEl.textContent = message;
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

function browserMeta() {
  return {
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Unknown",
    screen: `${window.screen.width}x${window.screen.height}`
  };
}

function redirect() {
  if (destinationUrl) {
    location.href = destinationUrl;
  }
}

async function recordOpen() {
  const payload = await requestJson(`/api/visits/${linkId}`, {
    method: "POST",
    body: JSON.stringify(browserMeta())
  });
  clickId = payload.clickId;
  destinationUrl = payload.destinationUrl;
}

function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("This browser does not support GPS location."));
      return;
    }

    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 15000,
      maximumAge: 0
    });
  });
}

async function saveLocation(permission, coords = null) {
  await requestJson(`/api/clicks/${clickId}/location`, {
    method: "PATCH",
    body: JSON.stringify({
      permission,
      latitude: coords?.latitude,
      longitude: coords?.longitude,
      accuracyMeters: coords?.accuracy
    })
  });
}


shareLocationButton.addEventListener("click", async () => {
  try {
    setStatus("");
    const position = await getPosition();
    await saveLocation("granted", position.coords);
    redirect();
  } catch (error) {
    await saveLocation("declined");
    setStatus(`${error.message} Continuing without GPS location...`);
    setTimeout(redirect, 900);
  }
});

recordOpen().catch((error) => {
  setStatus(error.message);
  shareLocationButton.disabled = true;
});
