// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// constructor(address client, address payable provider, uint256[] memory amounts)
// Milestone IDs start at 1; 1-5 milestones, each with a positive amount.
// Client and provider addresses must be nonzero and distinct.
interface IMilestoneEscrow {
    event Deposited(address indexed client, uint256 amount);
    event MilestonePaid(uint256 indexed id, address indexed provider, uint256 amount);
    function client() external view returns (address);
    function provider() external view returns (address);
    function totalAmount() external view returns (uint256);
    function milestoneCount() external view returns (uint256);
    function milestoneAmount(uint256 id) external view returns (uint256);
    function isPaid(uint256 id) external view returns (bool);
    function funded() external view returns (bool);
    function deposit() external payable;          // Client only; deposit the exact total once.
    function acceptMilestone(uint256 id) external; // Client only; pay funded milestones in order, once each.
}
