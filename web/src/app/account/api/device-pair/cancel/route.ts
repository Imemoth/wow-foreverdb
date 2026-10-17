import { PAIRING_INPUTS } from "@/lib/account/contracts-pairing";
import { nativePairingApi, cancelPairing } from "@/lib/account/pairing-native";

export const dynamic = "force-dynamic";

export const POST = nativePairingApi({ route: "cancel", body: PAIRING_INPUTS.cancel, maxBytes: 512 }, cancelPairing);
