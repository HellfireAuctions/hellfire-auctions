// Usage: BACKUP_SECRET="<your app secret or BACKUP_PASSPHRASE>" node scripts/decrypt-backup.mjs hellfire-backup-YYYY-MM-DD.enc > backup.json
import { readFileSync } from "node:fs";
import { createDecipheriv, scryptSync } from "node:crypto";
const file = readFileSync(process.argv[2]);
if (file.subarray(0, 4).toString() !== "HFB1") throw new Error("Not a Hellfire backup file");
const salt = file.subarray(4, 20);
const iv = file.subarray(20, 32);
const tag = file.subarray(32, 48);
const data = file.subarray(48);
const decipher = createDecipheriv("aes-256-gcm", scryptSync(process.env.BACKUP_SECRET, salt, 32), iv);
decipher.setAuthTag(tag);
process.stdout.write(Buffer.concat([decipher.update(data), decipher.final()]));
