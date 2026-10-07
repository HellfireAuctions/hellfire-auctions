// The app's front door (the address with nothing after it). Shopify's admin opens the app through this address, so
// anything that looks like it comes from the admin, or from inside the admin's frame, must be sent straight on to the
// app instead of seeing the public page. Only a plain visitor in a normal browser tab sees the public page.
export function shouldOpenApp(requestUrl, secFetchDest) {
  let params;
  try {
    params = new URL(requestUrl).searchParams;
  } catch {
    return false;
  }
  return Boolean(
    params.get("shop") ||
      params.get("embedded") === "1" ||
      params.get("host") ||
      params.get("id_token") ||
      String(secFetchDest || "").toLowerCase() === "iframe",
  );
}
