import { PAIRING_INPUTS } from "@/lib/account/contracts-pairing";
import { nativePairingApi, startPairing } from "@/lib/account/pairing-native";

export const dynamic = "force-dynamic";

export const POST = nativePairingApi({ route: "start", body: PAIRING_INPUTS.start, maxBytes: 2048 }, startPairing);
