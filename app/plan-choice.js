// "Has this store chosen a plan?" A new store used to be treated as Spark without ever being asked, so features looked
// missing until the merchant found the Plans page. Now the first thing the app does is ask. A plan counts as chosen when
// the merchant picks Spark on purpose, or when a paid plan is active on Shopify. Looking at the Plans page does not count.

// Stores with the free-forever Inferno arrangement are never asked. Everyone else is asked until they have chosen.
export const needsPlanChoice = ({ complimentary, row }) => !complimentary && !row?.planConfirmedAt;

// Saving a plan from Shopify's billing answer confirms it only when a paid subscription is actually active.
// Returning to Spark (cancelled) never un-chooses: whoever has chosen once has chosen.
export const confirmOnSync = (subscription) => Boolean(subscription);
