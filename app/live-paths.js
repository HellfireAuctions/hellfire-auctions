// Turns Shopify's answer about a list of products into "product id -> the page address on the storefront".
// A product counts if it is ACTIVE. Its page is the Online Store URL when Shopify gives one, otherwise /products/<handle>
// (every auction product is published to the Online Store by the app). Anything else is left out.
export function pathsFromNodes(nodes) {
  const paths = new Map();
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (!node || !node.id || node.status !== "ACTIVE") continue;
    let path = null;
    if (node.onlineStoreUrl) {
      try {
        path = new URL(node.onlineStoreUrl).pathname;
      } catch {
        path = null;
      }
    }
    if (!path && typeof node.handle === "string" && /^[a-z0-9][a-z0-9_-]*$/i.test(node.handle)) path = `/products/${node.handle}`;
    if (path && path.startsWith("/")) paths.set(node.id, path);
  }
  return paths;
}
