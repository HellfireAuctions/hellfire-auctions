import { stageImage } from "./shopify-upload.server.js";

// Live Drops makes its own products: the host types what the item is, the app creates it in the store. These products
// are created Active but NOT published to the Online Store, so they never appear in the shop's catalog. They exist so the
// shopper's invoice has real items on it.

async function imageAddress(admin, productId) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const json = await (
      await admin.graphql(
        `#graphql
          query DropImage($id: ID!) { product(id: $id) { media(first: 5) { nodes { ... on MediaImage { image { url } } } } } }`,
        { variables: { id: productId } },
      )
    ).json();
    const found = (json?.data?.product?.media?.nodes || []).find((m) => m?.image?.url);
    if (found) return found.image.url;
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  return null;
}

export async function createDropProduct({ admin, title, price, imageFile }) {
  const source = imageFile ? await stageImage(admin, imageFile) : null;
  const created = await (
    await admin.graphql(
      `#graphql
        mutation CreateDropProduct($product: ProductCreateInput!, $media: [CreateMediaInput!]) {
          productCreate(product: $product, media: $media) {
            product { id variants(first: 1) { nodes { id } } }
            userErrors { field message }
          }
        }`,
      {
        variables: {
          product: { title, status: "ACTIVE", productType: "Hellfire Live Drop", tags: ["Hellfire Live Drop"] },
          media: source ? [{ originalSource: source, alt: title, mediaContentType: "IMAGE" }] : null,
        },
      },
    )
  ).json();
  const result = created?.data?.productCreate;
  if (result?.userErrors?.length) throw new Error(result.userErrors.map((e) => e.message).join(", "));
  const productId = result?.product?.id;
  const variantId = result?.product?.variants?.nodes?.[0]?.id;
  if (!productId || !variantId) throw new Error("Shopify did not create the product.");

  // the show price goes on the product itself, so the order and the invoice both read correctly
  const priced = await (
    await admin.graphql(
      `#graphql
        mutation PriceDrop($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkUpdate(productId: $productId, variants: $variants) { userErrors { message } }
        }`,
      { variables: { productId, variants: [{ id: variantId, price: Number(price).toFixed(2) }] } },
    )
  ).json();
  const priceErrors = priced?.data?.productVariantsBulkUpdate?.userErrors || [];
  if (priceErrors.length) {
    await deleteDropProduct(admin, productId);
    throw new Error(priceErrors.map((e) => e.message).join(", "));
  }
  const imageUrl = source ? (await imageAddress(admin, productId)) || source : null;
  return { productId, variantId, imageUrl };
}

// Best effort: a leftover hidden product is harmless, so a failure here is only logged.
export async function deleteDropProduct(admin, productId) {
  try {
    const json = await (
      await admin.graphql(
        `#graphql
          mutation DeleteDropProduct($input: ProductDeleteInput!) { productDelete(input: $input) { deletedProductId userErrors { message } } }`,
        { variables: { input: { id: productId } } },
      )
    ).json();
    const errors = json?.data?.productDelete?.userErrors || [];
    if (errors.length) console.error("[HELLFIRE LIVE DROPS] product not deleted:", productId, errors.map((e) => e.message).join(", "));
  } catch (error) {
    console.error("[HELLFIRE LIVE DROPS] product not deleted:", productId, error?.message || error);
  }
}
