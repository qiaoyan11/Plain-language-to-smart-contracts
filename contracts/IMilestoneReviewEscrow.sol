// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./IMilestoneEscrow.sol";

// v2: a review period after each delivery (docs/REVIEW_PERIOD_V2.md). Everything in
// IMilestoneEscrow v1 still holds: the client may approve the next unpaid milestone at any time.
// The review period and the change-request limit are constants written into the contract.
//
// - The provider submits a delivery for the next unpaid milestone; its review period starts.
// - Before the period ends the client may request changes; the delivery is withdrawn and the
//   provider must submit again, which starts a new period. A nonzero limit caps these requests.
// - Once the period has ended with no change request, the provider may claim the payment.
interface IMilestoneReviewEscrow is IMilestoneEscrow {
    event DeliverySubmitted(uint256 indexed id, uint256 reviewEndsAt);
    event ChangesRequested(uint256 indexed id, uint256 requestCount);
    function reviewPeriod() external view returns (uint256);          // Seconds.
    function changeRequestLimit() external view returns (uint256);    // 0 means no limit.
    function deliveredAt(uint256 id) external view returns (uint256); // 0 when no delivery awaits review.
    function changeRequests(uint256 id) external view returns (uint256);
    function submitDelivery(uint256 id) external; // Provider only; funded; next unpaid; none awaiting review.
    function requestChanges(uint256 id) external; // Client only; before the review ends; within the limit.
    function claimMilestone(uint256 id) external; // Provider only; after the review ends; pays the milestone.
}
