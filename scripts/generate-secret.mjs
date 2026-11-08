// Prints a random secret: node scripts/generate-secret.mjs
import { randomBytes } from "node:crypto";
console.log(randomBytes(32).toString("hex"));
