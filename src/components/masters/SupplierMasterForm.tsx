import { AccountMasterForm } from "./AccountMasterForm";

export function SupplierMasterForm({
  windowId,
  payload,
}: {
  windowId: string;
  payload: Record<string, unknown>;
}) {
  return <AccountMasterForm windowId={windowId} payload={payload} accountType="SUPPLIER" />;
}
