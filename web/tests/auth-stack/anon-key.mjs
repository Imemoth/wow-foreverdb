// Prints an anon-role JWT signed with the stack's (public, test-only) JWT secret.
import { createHmac } from "node:crypto";
const secret = process.argv[2];
const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const head = b({ alg: "HS256", typ: "JWT" });
const body = b({ iss: "foreverdb-ci-stack", role: "anon", exp: 4102444800 });
console.log(`${head}.${body}.${createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url")}`);
