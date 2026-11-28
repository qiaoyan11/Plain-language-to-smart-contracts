// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./IMilestoneReviewEscrow.sol";

/// @notice Reference implementation of IMilestoneReviewEscrow v2: v1 escrow plus a review
/// period after each delivery. No cancellation or refund path; for testing, not real funds.
contract MilestoneReviewEscrow is IMilestoneReviewEscrow {
    uint256 public constant override reviewPeriod = 10 days;
    uint256 public constant override changeRequestLimit = 0;

    address public immutable override client;
    address public immutable override provider;
    uint256 public immutable override totalAmount;
    bool public override funded;

    uint256[] private amounts;
    uint256 private nextMilestone = 1;
    mapping(uint256 => uint256) private delivered;
    mapping(uint256 => uint256) private requests;

    error InvalidParties();
    error InvalidMilestoneCount();
    error InvalidAmount();
    error InvalidMilestoneId();
    error Unauthorized();
    error InvalidState();
    error IncorrectDeposit();
    error TransferFailed();

    constructor(address client_, address payable provider_, uint256[] memory amounts_) {
        if (client_ == address(0) || provider_ == address(0) || client_ == provider_) {
            revert InvalidParties();
        }
        if (amounts_.length == 0 || amounts_.length > 5) revert InvalidMilestoneCount();
        uint256 sum = 0;
        for (uint256 i = 0; i < amounts_.length; ++i) {
            if (amounts_[i] == 0) revert InvalidAmount();
            sum += amounts_[i];
        }
        client = client_;
        provider = provider_;
        amounts = amounts_;
        totalAmount = sum;
    }

    modifier onlyClient() {
        if (msg.sender != client) revert Unauthorized();
        _;
    }

    modifier onlyProvider() {
        if (msg.sender != provider) revert Unauthorized();
        _;
    }

    function milestoneCount() external view override returns (uint256) {
        return amounts.length;
    }

    function milestoneAmount(uint256 id) external view override returns (uint256) {
        checkId(id);
        return amounts[id - 1];
    }

    function isPaid(uint256 id) external view override returns (bool) {
        checkId(id);
        return id < nextMilestone;
    }

    function deliveredAt(uint256 id) external view override returns (uint256) {
        checkId(id);
        return delivered[id];
    }

    function changeRequests(uint256 id) external view override returns (uint256) {
        checkId(id);
        return requests[id];
    }

    function deposit() external payable override onlyClient {
        if (funded) revert InvalidState();
        if (msg.value != totalAmount) revert IncorrectDeposit();
        funded = true;
        emit Deposited(msg.sender, msg.value);
    }

    function acceptMilestone(uint256 id) external override onlyClient {
        checkNext(id);
        uint256 amount = markPaid(id);
        (bool sent, ) = payable(provider).call{value: amount}("");
        if (!sent) revert TransferFailed();
    }

    function submitDelivery(uint256 id) external override onlyProvider {
        checkNext(id);
        if (delivered[id] != 0) revert InvalidState();
        delivered[id] = block.timestamp;
        emit DeliverySubmitted(id, block.timestamp + reviewPeriod);
    }

    function requestChanges(uint256 id) external override onlyClient {
        checkNext(id);
        uint256 at = delivered[id];
        if (at == 0 || block.timestamp >= at + reviewPeriod) revert InvalidState();
        if (changeRequestLimit != 0 && requests[id] >= changeRequestLimit) revert InvalidState();
        delivered[id] = 0;
        uint256 count = requests[id] + 1;
        requests[id] = count;
        emit ChangesRequested(id, count);
    }

    function claimMilestone(uint256 id) external override onlyProvider {
        checkNext(id);
        uint256 at = delivered[id];
        if (at == 0 || block.timestamp < at + reviewPeriod) revert InvalidState();
        uint256 amount = markPaid(id);
        (bool sent, ) = payable(provider).call{value: amount}("");
        if (!sent) revert TransferFailed();
    }

    // Effects before the transfer, which each caller makes right after its own access check;
    // a failed transfer reverts these effects too.
    function markPaid(uint256 id) private returns (uint256 amount) {
        amount = amounts[id - 1];
        ++nextMilestone;
        delivered[id] = 0;
        emit MilestonePaid(id, provider, amount);
    }

    function checkNext(uint256 id) private view {
        checkId(id);
        if (!funded || id != nextMilestone) revert InvalidState();
    }

    function checkId(uint256 id) private view {
        if (id == 0 || id > amounts.length) revert InvalidMilestoneId();
    }
}
