// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// constructor(address client, address payable provider, uint256[] memory amounts)
// 阶段编号从 1 开始；1–5 个阶段；每个金额 > 0；client 和 provider 非零且不同
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
    function deposit() external payable;          // 仅 client，金额必须等于 totalAmount，只能一次
    function acceptMilestone(uint256 id) external; // 仅 client，已存款，按顺序，每个只付一次
}
