import "../proposals.css";
import { PurchaseProposalDetail } from "./proposal-detail";
export default async function PurchaseProposalPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return <PurchaseProposalDetail id={(await params).id} />;
}
