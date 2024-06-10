// SPDX-License-Identifier: GPL-3.0

pragma solidity ^0.8.15;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/utils/Strings.sol";
import "./ITraceableContract.sol";

import "hardhat/console.sol";
import "./satp-contract-interface.sol";


contract SATPContract is AccessControl, ERC20, ITraceableContract, SATPContractInterface {

    bytes32 public constant BRIDGE_ROLE = keccak256("BRIDGE_ROLE");
    bytes32 public constant OWNER_ROLE = keccak256("OWNER_ROLE");

    string public id;

    mapping (string => uint256) public balanceOf;

    constructor(address _owner, string memory _id) ERC20("SATPToken", "SATP") {
        _grantRole(OWNER_ROLE, _owner);
        _grantRole(BRIDGE_ROLE, _owner);

        id = _id;
        string[] memory t = new string[](1);
        t[0] = "atoa";
        emit Changed(id, t);
    }

    function mint(address account, uint256 amount) external onlyRole(BRIDGE_ROLE) returns (bool success) {
        console.log("Mint to: %s\n amount: %s", account, amount);
        _mint(account, amount);
        string[] memory t = new string[](1);
        t[0] = "atoa";
        emit Changed(id, t);
        return true;
    }

    function burn(address account, uint256 amount) external onlyRole(BRIDGE_ROLE) returns (bool success) {
        console.log("Burn from: %s\n amount: %s", account, amount);
        _burn(account, amount);
        string[] memory t = new string[](1);
        t[0] = "atoa";
        emit Changed(id, t);
        return true;
    }

    function assign(address from, address recipient, uint256 amount) external onlyRole(BRIDGE_ROLE) returns (bool success) {
        console.log("Assing from: %s\n to: %s \n amount: %s", from, recipient, amount);
        require(from == _msgSender(), "The msgSender is not the owner");
        _transfer(from, recipient, amount);
        string[] memory t = new string[](1);
        t[0] = "atoa";
        emit Changed(id, t);
        return true;
    }

    function transfer(address from, address recipient, uint256 amount) external onlyRole(BRIDGE_ROLE) returns (bool success) {
        console.log("transfer from: %s\n to: %s \n amount: %s", from, recipient, amount);
        transferFrom(from, recipient, amount);
        string[] memory t = new string[](1);
        t[0] = "atoa";
        emit Changed(id, t);
        return true;
    }

    function getAllAssetsIDs() external view returns (string[] memory) {
        string[] memory myArray = new string[](1);
        myArray[0] = id;
        return myArray;
    }

    function getId() view public returns (string memory) {
        return id;
    }

    function giveRole(address account) external onlyRole(OWNER_ROLE) returns (bool success) {
        _grantRole(BRIDGE_ROLE, account);
        string[] memory t = new string[](1);
        t[0] = "atoa";
        emit Changed(id, t);
        return true;
    }
}