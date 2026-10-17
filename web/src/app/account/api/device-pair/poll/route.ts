import { PAIRING_INPUTS } from "@/lib/account/contracts-pairing";
import { nativePairingApi, pollPairing } from "@/lib/account/pairing-native";

export const dynamic = "force-dynamic";

export const POST = nativePairingApi({ route: "poll", body: PAIRING_INPUTS.poll, maxBytes: 512 }, pollPairing);
