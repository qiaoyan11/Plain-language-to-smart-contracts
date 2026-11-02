// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./IMilestoneEscrow.sol";

/// @notice Sequential, client-approved escrow implementing IMilestoneEscrow v1.
/// No cancellation or refund path; for testing, not real funds.
contract MilestoneEscrow is IMilestoneEscrow {
    address public immutable override client;
    address public immutable override provider;
    uint256 public immutable override totalAmount;
    bool public override funded;

    uint256[] private amounts;
    uint256 private nextMilestone = 1;

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
        uint256 sum;
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

    function deposit() external payable override onlyClient {
        if (funded) revert InvalidState();
        if (msg.value != totalAmount) revert IncorrectDeposit();
        funded = true;
        emit Deposited(msg.sender, msg.value);
    }

    function acceptMilestone(uint256 id) external override onlyClient {
        checkId(id);
        if (!funded || id != nextMilestone) revert InvalidState();
        uint256 amount = amounts[id - 1];
        // Commit effects before calling the recipient; failure reverts both.
        ++nextMilestone;
        emit MilestonePaid(id, provider, amount);
        (bool sent, ) = payable(provider).call{value: amount}("");
        if (!sent) revert TransferFailed();
    }

    function checkId(uint256 id) private view {
        if (id == 0 || id > amounts.length) revert InvalidMilestoneId();
    }
}
