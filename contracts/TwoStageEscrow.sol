// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Fixed reference contract for local learning and integration tests.
/// No cancellation or refund path: do not use with real funds.
contract TwoStageEscrow {
    address public immutable client;
    address payable public immutable provider;
    uint256 public constant TOTAL = 0.01 ether;
    uint256 public constant FIRST_PAYMENT = 0.003 ether;
    uint256 public constant SECOND_PAYMENT = 0.007 ether;

    enum State { AwaitingDeposit, Funded, FirstPaid, Completed }
    State public state;

    error InvalidParties();
    error Unauthorized();
    error InvalidState();
    error IncorrectDeposit();
    error TransferFailed();

    event Deposited(address indexed client, uint256 amount);
    event MilestonePaid(uint8 indexed milestone, address indexed provider, uint256 amount);

    constructor(address client_, address payable provider_) {
        if (client_ == address(0) || provider_ == address(0) || client_ == provider_) {
            revert InvalidParties();
        }
        client = client_;
        provider = provider_;
    }

    modifier onlyClient() {
        if (msg.sender != client) revert Unauthorized();
        _;
    }

    function deposit() external payable onlyClient {
        if (state != State.AwaitingDeposit) revert InvalidState();
        if (msg.value != TOTAL) revert IncorrectDeposit();
        state = State.Funded;
        emit Deposited(msg.sender, msg.value);
    }

    function approveFirst() external onlyClient {
        if (state != State.Funded) revert InvalidState();
        state = State.FirstPaid;
        (bool sent, ) = provider.call{value: FIRST_PAYMENT}("");
        if (!sent) revert TransferFailed();
        emit MilestonePaid(1, provider, FIRST_PAYMENT);
    }

    function approveSecond() external onlyClient {
        if (state != State.FirstPaid) revert InvalidState();
        state = State.Completed;
        (bool sent, ) = provider.call{value: SECOND_PAYMENT}("");
        if (!sent) revert TransferFailed();
        emit MilestonePaid(2, provider, SECOND_PAYMENT);
    }
}
