// Uploads a photo to Shopify's staging area and returns the address Shopify can attach to a product.
export async function stageImage(admin, imageFile) {
  const staged = await (
    await admin.graphql(
      `#graphql
        mutation StagedUpload($input: [StagedUploadInput!]!) {
          stagedUploadsCreate(input: $input) {
            stagedTargets { url resourceUrl parameters { name value } }
            userErrors { message }
          }
        }`,
      { variables: { input: [{ filename: imageFile.name, mimeType: imageFile.type, httpMethod: "POST", resource: "PRODUCT_IMAGE" }] } },
    )
  ).json();
  const result = staged?.data?.stagedUploadsCreate;
  if (result?.userErrors?.length) throw new Error(result.userErrors.map((e) => e.message).join(", "));
  const target = result?.stagedTargets?.[0];
  if (!target) throw new Error("Shopify did not provide an image upload target.");
  const body = new FormData();
  for (const parameter of target.parameters) body.append(parameter.name, parameter.value);
  body.append("file", imageFile, imageFile.name);
  const response = await fetch(target.url, { method: "POST", body });
  if (!response.ok) throw new Error("Shopify image upload failed.");
  return target.resourceUrl;
}
