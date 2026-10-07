// The "Show the floating Live Auctions button" switch in the app's settings.
// A checkbox sends its value only when ticked, so the form also sends a hidden "off": the choice is "on" only if "on" was sent.
export const wantsBubble = (values) => Array.isArray(values) && values.includes("on");

// Stores that never touched the switch (or whose settings row predates it) have the button on.
export const bubbleOn = (row) => row?.showLiveBubble !== false;
