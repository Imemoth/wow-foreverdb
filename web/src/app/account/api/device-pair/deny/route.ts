import { accountApi } from "@/lib/account/handler";
import { INPUTS } from "@/lib/account/inputs";
import { decidePairing } from "@/lib/account/pairing-browser";

export const dynamic = "force-dynamic";

export const POST = accountApi({ route: "pairing_deny", mutating: true, body: INPUTS.pairingDecision }, (c, body) =>
  decidePairing(c, body, "deny"));
