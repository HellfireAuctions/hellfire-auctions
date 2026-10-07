// Reads a spreadsheet saved as CSV (Excel or Google Sheets: File > Download > CSV) into auction rows.
// Pure functions with no dependencies, so the browser and the tests use the same code.

import { parseBuyNowPrice } from "./buy-now.js";

export const MAX_ROWS = 100;
export const REQUIRED = ["title", "startingBid", "imageUrl"];

const ALIASES = {
  title: ["title", "name", "product", "producttitle", "itemname"],
  description: ["description", "desc", "details", "about"],
  startingBid: ["startingbid", "startbid", "startingprice", "startprice", "price", "opening", "openingbid"],
  reservePrice: ["reserve", "reserveprice", "reservebid"],
  buyNowPrice: ["buynowprice", "buynow", "buyitnow", "buyitnowprice", "bin", "buyoutprice", "buyout"],
  imageUrl: ["imageurl", "image", "photo", "photourl", "picture", "imagelink", "photolink"],
  weight: ["weight", "shippingweight"],
  weightUnit: ["weightunit", "unit", "weightuom"],
};

const UNITS = {
  oz: "OUNCES", ounce: "OUNCES", ounces: "OUNCES",
  lb: "POUNDS", lbs: "POUNDS", pound: "POUNDS", pounds: "POUNDS",
  g: "GRAMS", gram: "GRAMS", grams: "GRAMS",
  kg: "KILOGRAMS", kilogram: "KILOGRAMS", kilograms: "KILOGRAMS",
};

const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

export function parseCsv(text) {
  const src = String(text ?? "").replace(/^\uFEFF/, "");
  const firstLine = src.split(/\r?\n/, 1)[0] || "";
  const delimiter = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ";" : ",";
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  const endRow = () => {
    row.push(field);
    field = "";
    if (row.some((cell) => cell.trim() !== "")) rows.push(row);
    row = [];
  };
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === delimiter) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i += 1;
      endRow();
    } else {
      field += c;
    }
  }
  endRow();
  return rows;
}

function money(value) {
  const n = Number(String(value ?? "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
}

function buildRow(cells, col, line) {
  const get = (field) => (col[field] === undefined ? "" : String(cells[col[field]] ?? "").trim());
  const problems = [];
  const title = get("title");
  if (!title) problems.push("Missing title");
  else if (title.length > 255) problems.push("Title is longer than 255 characters");

  const startingBid = money(get("startingBid"));
  if (!(startingBid > 0)) problems.push("Starting bid must be a number above 0");

  let reservePrice = null;
  if (get("reservePrice") !== "") {
    reservePrice = money(get("reservePrice"));
    if (!(reservePrice > startingBid)) problems.push("Reserve price must be higher than the starting bid (or leave it empty)");
  }

  let buyNowPrice = null;
  if (get("buyNowPrice") !== "") {
    const parsed = parseBuyNowPrice(money(get("buyNowPrice")), { startingBid, reservePrice });
    if (parsed.ok) buyNowPrice = parsed.value;
    else problems.push(parsed.error);
  }

  const imageUrl = get("imageUrl");
  if (!/^https:\/\/[^\s]{4,2000}$/.test(imageUrl)) problems.push("Image link must start with https://");

  let weightValue = null;
  let weightUnit = "OUNCES";
  if (get("weight") !== "") {
    weightValue = money(get("weight"));
    if (!(weightValue > 0)) problems.push("Weight must be a number above 0 (or leave it empty)");
  }
  if (get("weightUnit") !== "") {
    const unit = UNITS[norm(get("weightUnit"))];
    if (unit) weightUnit = unit;
    else problems.push(`Unknown weight unit "${get("weightUnit")}" (use oz, lb, g or kg)`);
  }

  const description = get("description");
  if (description.length > 5000) problems.push("Description is longer than 5000 characters");

  return { line, problems, data: { title, description, startingBid, reservePrice, buyNowPrice, imageUrl, weightValue, weightUnit } };
}

export function readAuctionRows(text) {
  const grid = parseCsv(text);
  if (!grid.length) return { rows: [], missingColumns: REQUIRED.slice(), tooMany: false, total: 0 };
  const header = grid[0].map(norm);
  const col = {};
  for (const [field, names] of Object.entries(ALIASES)) {
    const idx = header.findIndex((h) => names.includes(h));
    if (idx >= 0) col[field] = idx;
  }
  const missingColumns = REQUIRED.filter((f) => col[f] === undefined);
  const body = grid.slice(1);
  const rows = body.slice(0, MAX_ROWS).map((cells, i) => buildRow(cells, col, i + 2));
  return { rows, missingColumns, tooMany: body.length > MAX_ROWS, total: body.length };
}

export const CSV_TEMPLATE = [
  "title,description,starting bid,reserve price,buy it now price,image url,weight,weight unit",
  '"Rainbow Zoanthid frag","Colony of 10 polyps, healthy and growing",25,60,90,https://example.com/photos/zoanthid.jpg,4,oz',
  '"Blue Tenuis Acro frag","1 inch frag, fully encrusted",40,,,https://example.com/photos/acro.jpg,3,oz',
].join("\n");
