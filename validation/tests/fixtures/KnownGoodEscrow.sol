// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./IMilestoneEscrow.sol";

// Validator self-test fixture only: a known-good IMilestoneEscrow v1 implementation that the
// mutation tests break on purpose. It is never the object under validation for a generated run.
contract KnownGoodEscrow is IMilestoneEscrow {
    address public immutable override client;
    address public immutable override provider;
    uint256 public immutable override totalAmount;
    bool public override funded;

    uint256[] private amounts;
    mapping(uint256 => bool) private paid;
    uint256 private nextMilestone = 1;

    error Rejected();

    constructor(address client_, address payable provider_, uint256[] memory amounts_) {
        if (client_ == address(0) || provider_ == address(0)) revert Rejected();
        if (client_ == provider_) revert Rejected();
        if (amounts_.length == 0 || amounts_.length > 5) revert Rejected();
        uint256 sum = 0;
        for (uint256 i = 0; i < amounts_.length; ++i) {
            if (amounts_[i] == 0) revert Rejected();
            sum += amounts_[i];
        }
        client = client_;
        provider = provider_;
        totalAmount = sum;
        amounts = amounts_;
    }

    function milestoneCount() external view override returns (uint256) {
        return amounts.length;
    }

    function milestoneAmount(uint256 id) external view override returns (uint256) {
        if (id == 0 || id > amounts.length) revert Rejected();
        return amounts[id - 1];
    }

    function isPaid(uint256 id) external view override returns (bool) {
        if (id == 0 || id > amounts.length) revert Rejected();
        return paid[id];
    }

    function deposit() external payable override {
        if (msg.sender != client) revert Rejected();
        if (funded) revert Rejected();
        if (msg.value != totalAmount) revert Rejected();
        funded = true;
        emit Deposited(msg.sender, msg.value);
    }

    function acceptMilestone(uint256 id) external override {
        if (msg.sender != client) revert Rejected();
        if (!funded) revert Rejected();
        if (id == 0 || id > amounts.length) revert Rejected();
        if (id != nextMilestone) revert Rejected();
        paid[id] = true;
        nextMilestone = id + 1;
        uint256 amount = amounts[id - 1];
        emit MilestonePaid(id, provider, amount);
        (bool ok, ) = payable(provider).call{value: amount}("");
        if (!ok) revert Rejected();
    }
}
