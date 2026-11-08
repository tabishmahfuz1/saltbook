import { AccountMasterForm } from "./AccountMasterForm";

export function PartyMasterForm({
  windowId,
  payload,
}: {
  windowId: string;
  payload: Record<string, unknown>;
}) {
  return <AccountMasterForm windowId={windowId} payload={payload} accountType="PARTY" />;
}
