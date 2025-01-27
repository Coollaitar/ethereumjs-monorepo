import { RLP } from '@ethereumjs/rlp'
import {
  MAX_INTEGER,
  bigIntToHex,
  bigIntToUnpaddedBytes,
  bytesToBigInt,
  bytesToHex,
  bytesToPrefixedHexString,
  computeVersionedHash,
  concatBytes,
  ecrecover,
  equalsBytes,
  hexStringToBytes,
  kzg,
  toBytes,
  validateNoLeadingZeroes,
} from '@ethereumjs/util'
import { keccak256 } from 'ethereum-cryptography/keccak'

import { BaseTransaction } from './baseTransaction'
import { LIMIT_BLOBS_PER_TX } from './constants'
import { AccessLists } from './util'

import type {
  AccessList,
  AccessListBytes,
  BlobEIP4844NetworkValuesArray,
  BlobEIP4844TxData,
  BlobEIP4844ValuesArray,
  JsonTx,
  TxOptions,
} from './types'
import type { Common } from '@ethereumjs/common'

const TRANSACTION_TYPE = 0x03
const TRANSACTION_TYPE_BYTES = hexStringToBytes(TRANSACTION_TYPE.toString(16).padStart(2, '0'))

const validateBlobTransactionNetworkWrapper = (
  versionedHashes: Uint8Array[],
  blobs: Uint8Array[],
  commitments: Uint8Array[],
  kzgProofs: Uint8Array[],
  version: number
) => {
  if (!(versionedHashes.length === blobs.length && blobs.length === commitments.length)) {
    throw new Error('Number of versionedHashes, blobs, and commitments not all equal')
  }
  if (versionedHashes.length === 0) {
    throw new Error('Invalid transaction with empty blobs')
  }

  try {
    kzg.verifyBlobKzgProofBatch(blobs, commitments, kzgProofs)
  } catch (e) {
    throw new Error('KZG proof cannot be verified from blobs/commitments')
  }

  for (let x = 0; x < versionedHashes.length; x++) {
    const computedVersionedHash = computeVersionedHash(commitments[x], version)
    if (!equalsBytes(computedVersionedHash, versionedHashes[x])) {
      throw new Error(`commitment for blob at index ${x} does not match versionedHash`)
    }
  }
}

/**
 * Typed transaction with a new gas fee market mechanism for transactions that include "blobs" of data
 *
 * - TransactionType: 5
 * - EIP: [EIP-4844](https://eips.ethereum.org/EIPS/eip-4844)
 */
export class BlobEIP4844Transaction extends BaseTransaction<BlobEIP4844Transaction> {
  public readonly chainId: bigint
  public readonly accessList: AccessListBytes
  public readonly AccessListJSON: AccessList
  public readonly maxPriorityFeePerGas: bigint
  public readonly maxFeePerGas: bigint
  public readonly maxFeePerDataGas: bigint

  public readonly common: Common
  public versionedHashes: Uint8Array[]
  blobs?: Uint8Array[] // This property should only be populated when the transaction is in the "Network Wrapper" format
  kzgCommitments?: Uint8Array[] // This property should only be populated when the transaction is in the "Network Wrapper" format
  kzgProofs?: Uint8Array[] // This property should only be populated when the transaction is in the "Network Wrapper" format

  /**
   * This constructor takes the values, validates them, assigns them and freezes the object.
   *
   * It is not recommended to use this constructor directly. Instead use
   * the static constructors or factory methods to assist in creating a Transaction object from
   * varying data types.
   */
  constructor(txData: BlobEIP4844TxData, opts: TxOptions = {}) {
    super({ ...txData, type: TRANSACTION_TYPE }, opts)
    const { chainId, accessList, maxFeePerGas, maxPriorityFeePerGas, maxFeePerDataGas } = txData

    this.common = this._getCommon(opts.common, chainId)
    this.chainId = this.common.chainId()

    if (this.common.isActivatedEIP(1559) === false) {
      throw new Error('EIP-1559 not enabled on Common')
    }

    if (this.common.isActivatedEIP(4844) === false) {
      throw new Error('EIP-4844 not enabled on Common')
    }
    this.activeCapabilities = this.activeCapabilities.concat([1559, 2718, 2930])

    // Populate the access list fields
    const accessListData = AccessLists.getAccessListData(accessList ?? [])
    this.accessList = accessListData.accessList
    this.AccessListJSON = accessListData.AccessListJSON
    // Verify the access list format.
    AccessLists.verifyAccessList(this.accessList)

    this.maxFeePerGas = bytesToBigInt(toBytes(maxFeePerGas === '' ? '0x' : maxFeePerGas))
    this.maxPriorityFeePerGas = bytesToBigInt(
      toBytes(maxPriorityFeePerGas === '' ? '0x' : maxPriorityFeePerGas)
    )

    this._validateCannotExceedMaxInteger({
      maxFeePerGas: this.maxFeePerGas,
      maxPriorityFeePerGas: this.maxPriorityFeePerGas,
    })

    BaseTransaction._validateNotArray(txData)

    if (this.gasLimit * this.maxFeePerGas > MAX_INTEGER) {
      const msg = this._errorMsg('gasLimit * maxFeePerGas cannot exceed MAX_INTEGER (2^256-1)')
      throw new Error(msg)
    }

    if (this.maxFeePerGas < this.maxPriorityFeePerGas) {
      const msg = this._errorMsg(
        'maxFeePerGas cannot be less than maxPriorityFeePerGas (The total must be the larger of the two)'
      )
      throw new Error(msg)
    }

    this.maxFeePerDataGas = bytesToBigInt(
      toBytes((maxFeePerDataGas ?? '') === '' ? '0x' : maxFeePerDataGas)
    )

    this.versionedHashes = (txData.versionedHashes ?? []).map((vh) => toBytes(vh))
    this._validateYParity()
    this._validateHighS()

    for (const hash of this.versionedHashes) {
      if (hash.length !== 32) {
        const msg = this._errorMsg('versioned hash is invalid length')
        throw new Error(msg)
      }
      if (
        BigInt(hash[0]) !== this.common.paramByEIP('sharding', 'blobCommitmentVersionKzg', 4844)
      ) {
        const msg = this._errorMsg('versioned hash does not start with KZG commitment version')
        throw new Error(msg)
      }
    }
    if (this.versionedHashes.length > LIMIT_BLOBS_PER_TX) {
      const msg = this._errorMsg(`tx can contain at most ${LIMIT_BLOBS_PER_TX} blobs`)
      throw new Error(msg)
    }

    this.blobs = txData.blobs?.map((blob) => toBytes(blob))
    this.kzgCommitments = txData.kzgCommitments?.map((commitment) => toBytes(commitment))
    this.kzgProofs = txData.kzgProofs?.map((proof) => toBytes(proof))
    const freeze = opts?.freeze ?? true
    if (freeze) {
      Object.freeze(this)
    }
  }

  public static fromTxData(txData: BlobEIP4844TxData, opts?: TxOptions) {
    return new BlobEIP4844Transaction(txData, opts)
  }

  /**
   * Creates the minimal representation of a blob transaction from the network wrapper version.
   * The minimal representation is used when adding transactions to an execution payload/block
   * @param txData a {@link BlobEIP4844Transaction} containing optional blobs/kzg commitments
   * @param opts - dictionary of {@link TxOptions}
   * @returns the "minimal" representation of a BlobEIP4844Transaction (i.e. transaction object minus blobs and kzg commitments)
   */
  public static minimalFromNetworkWrapper(txData: BlobEIP4844Transaction, opts?: TxOptions) {
    const tx = BlobEIP4844Transaction.fromTxData(
      {
        ...txData,
        ...{ blobs: undefined, kzgCommitments: undefined, kzgProofs: undefined },
      },
      opts
    )
    return tx
  }

  /**
   * Instantiate a transaction from the serialized tx.
   *
   * Format: `0x03 || rlp([chain_id, nonce, max_priority_fee_per_gas, max_fee_per_gas, gas_limit, to, value, data,
   * access_list, max_fee_per_data_gas, blob_versioned_hashes, y_parity, r, s])`
   */
  public static fromSerializedTx(serialized: Uint8Array, opts: TxOptions = {}) {
    if (equalsBytes(serialized.subarray(0, 1), TRANSACTION_TYPE_BYTES) === false) {
      throw new Error(
        `Invalid serialized tx input: not an EIP-4844 transaction (wrong tx type, expected: ${TRANSACTION_TYPE}, received: ${bytesToHex(
          serialized.subarray(0, 1)
        )}`
      )
    }

    const values = RLP.decode(serialized.subarray(1))

    if (!Array.isArray(values)) {
      throw new Error('Invalid serialized tx input: must be array')
    }

    return BlobEIP4844Transaction.fromValuesArray(values as any, opts)
  }

  /**
   * Create a transaction from a values array.
   *
   * Format: `[chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit, to, value, data,
   * accessList, signatureYParity, signatureR, signatureS]`
   */
  public static fromValuesArray(values: BlobEIP4844ValuesArray, opts: TxOptions = {}) {
    if (values.length !== 11 && values.length !== 14) {
      throw new Error(
        'Invalid EIP-4844 transaction. Only expecting 11 values (for unsigned tx) or 14 values (for signed tx).'
      )
    }

    const [
      chainId,
      nonce,
      maxPriorityFeePerGas,
      maxFeePerGas,
      gasLimit,
      to,
      value,
      data,
      accessList,
      maxFeePerDataGas,
      versionedHashes,
      v,
      r,
      s,
    ] = values

    this._validateNotArray({ chainId, v })
    validateNoLeadingZeroes({
      nonce,
      maxPriorityFeePerGas,
      maxFeePerGas,
      gasLimit,
      value,
      maxFeePerDataGas,
      v,
      r,
      s,
    })

    return new BlobEIP4844Transaction(
      {
        chainId: bytesToBigInt(chainId),
        nonce,
        maxPriorityFeePerGas,
        maxFeePerGas,
        gasLimit,
        to,
        value,
        data,
        accessList: accessList ?? [],
        maxFeePerDataGas,
        versionedHashes,
        v: v !== undefined ? bytesToBigInt(v) : undefined, // EIP2930 supports v's with value 0 (empty Uint8Array)
        r,
        s,
      },
      opts
    )
  }

  /**
   * Creates a transaction from the network encoding of a blob transaction (with blobs/commitments/proof)
   * @param serialized a buffer representing a serialized BlobTransactionNetworkWrapper
   * @param opts any TxOptions defined
   * @returns a BlobEIP4844Transaction
   */

  public static fromSerializedBlobTxNetworkWrapper(
    serialized: Uint8Array,
    opts?: TxOptions
  ): BlobEIP4844Transaction {
    if (!opts || !opts.common) {
      throw new Error('common instance required to validate versioned hashes')
    }

    if (equalsBytes(serialized.subarray(0, 1), TRANSACTION_TYPE_BYTES) === false) {
      throw new Error(
        `Invalid serialized tx input: not an EIP-4844 transaction (wrong tx type, expected: ${TRANSACTION_TYPE}, received: ${bytesToHex(
          serialized.subarray(0, 1)
        )}`
      )
    }

    // Validate network wrapper
    const networkTxValues = RLP.decode(serialized.subarray(1))
    if (networkTxValues.length !== 4) {
      throw Error(`Expected 4 values in the deserialized network transaction`)
    }
    const [txValues, blobs, kzgCommitments, kzgProofs] =
      networkTxValues as BlobEIP4844NetworkValuesArray

    // Construct the tx but don't freeze yet, we will assign blobs etc once validated
    const decodedTx = BlobEIP4844Transaction.fromValuesArray(txValues, { ...opts, freeze: false })
    if (decodedTx.to === undefined) {
      throw Error('BlobEIP4844Transaction can not be send without a valid `to`')
    }

    const version = Number(opts.common.paramByEIP('sharding', 'blobCommitmentVersionKzg', 4844))
    validateBlobTransactionNetworkWrapper(
      decodedTx.versionedHashes,
      blobs,
      kzgCommitments,
      kzgProofs,
      version
    )

    // set the network blob data on the tx
    decodedTx.blobs = blobs
    decodedTx.kzgCommitments = kzgCommitments
    decodedTx.kzgProofs = kzgProofs

    // freeze the tx
    const freeze = opts?.freeze ?? true
    if (freeze) {
      Object.freeze(decodedTx)
    }

    return decodedTx
  }

  /**
   * The up front amount that an account must have for this transaction to be valid
   * @param baseFee The base fee of the block (will be set to 0 if not provided)
   */
  getUpfrontCost(baseFee: bigint = BigInt(0)): bigint {
    const prio = this.maxPriorityFeePerGas
    const maxBase = this.maxFeePerGas - baseFee
    const inclusionFeePerGas = prio < maxBase ? prio : maxBase
    const gasPrice = inclusionFeePerGas + baseFee
    return this.gasLimit * gasPrice + this.value
  }

  /**
   * Returns a Uint8Array Array of the raw Bytes of the EIP-4844 transaction, in order.
   *
   * Format: [chain_id, nonce, max_priority_fee_per_gas, max_fee_per_gas, gas_limit, to, value, data,
   * access_list, max_fee_per_data_gas, blob_versioned_hashes, y_parity, r, s]`.
   *
   * Use {@link BlobEIP4844Transaction.serialize} to add a transaction to a block
   * with {@link Block.fromValuesArray}.
   *
   * For an unsigned tx this method uses the empty Bytes values for the
   * signature parameters `v`, `r` and `s` for encoding. For an EIP-155 compliant
   * representation for external signing use {@link BlobEIP4844Transaction.getMessageToSign}.
   */
  raw(): BlobEIP4844ValuesArray {
    return [
      bigIntToUnpaddedBytes(this.chainId),
      bigIntToUnpaddedBytes(this.nonce),
      bigIntToUnpaddedBytes(this.maxPriorityFeePerGas),
      bigIntToUnpaddedBytes(this.maxFeePerGas),
      bigIntToUnpaddedBytes(this.gasLimit),
      this.to !== undefined ? this.to.bytes : new Uint8Array(0),
      bigIntToUnpaddedBytes(this.value),
      this.data,
      this.accessList,
      bigIntToUnpaddedBytes(this.maxFeePerDataGas),
      this.versionedHashes,
      this.v !== undefined ? bigIntToUnpaddedBytes(this.v) : new Uint8Array(0),
      this.r !== undefined ? bigIntToUnpaddedBytes(this.r) : new Uint8Array(0),
      this.s !== undefined ? bigIntToUnpaddedBytes(this.s) : new Uint8Array(0),
    ]
  }

  /**
   * Returns the serialized encoding of the EIP-4844 transaction.
   *
   * Format: `0x03 || rlp([chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit, to, value, data,
   * access_list, max_fee_per_data_gas, blob_versioned_hashes, y_parity, r, s])`.
   *
   * Note that in contrast to the legacy tx serialization format this is not
   * valid RLP any more due to the raw tx type preceding and concatenated to
   * the RLP encoding of the values.
   */
  serialize(): Uint8Array {
    const base = this.raw()
    return concatBytes(TRANSACTION_TYPE_BYTES, RLP.encode(base))
  }

  /**
   * @returns the serialized form of a blob transaction in the network wrapper format (used for gossipping mempool transactions over devp2p)
   */
  serializeNetworkWrapper(): Uint8Array {
    if (
      this.blobs === undefined ||
      this.kzgCommitments === undefined ||
      this.kzgProofs === undefined
    ) {
      throw new Error(
        'cannot serialize network wrapper without blobs, KZG commitments and KZG proofs provided'
      )
    }

    const tx_payload = this.raw()
    return concatBytes(
      TRANSACTION_TYPE_BYTES,
      RLP.encode([tx_payload, this.blobs, this.kzgCommitments, this.kzgProofs])
    )
  }

  getMessageToSign(hashMessage = true): Uint8Array {
    const base = this.raw().slice(0, 11)
    const message = concatBytes(TRANSACTION_TYPE_BYTES, RLP.encode(base))
    return hashMessage ? keccak256(message) : message
  }

  /**
   * Computes a sha3-256 hash of the serialized tx.
   *
   * This method can only be used for signed txs (it throws otherwise).
   * Use {@link BlobEIP4844Transaction.getMessageToSign} to get a tx hash for the purpose of signing.
   */
  public hash(): Uint8Array {
    if (!this.isSigned()) {
      const msg = this._errorMsg('Cannot call hash method if transaction is not signed')
      throw new Error(msg)
    }

    if (Object.isFrozen(this)) {
      if (!this.cache.hash) {
        this.cache.hash = keccak256(this.serialize())
      }
      return this.cache.hash
    }

    return keccak256(this.serialize())
  }

  getMessageToVerifySignature(): Uint8Array {
    return this.getMessageToSign()
  }

  /**
   * Returns the public key of the sender
   */
  public getSenderPublicKey(): Uint8Array {
    if (!this.isSigned()) {
      const msg = this._errorMsg('Cannot call this method if transaction is not signed')
      throw new Error(msg)
    }

    const msgHash = this.getMessageToVerifySignature()
    const { v, r, s } = this

    this._validateHighS()

    try {
      return ecrecover(
        msgHash,
        v! + BigInt(27), // Recover the 27 which was stripped from ecsign
        bigIntToUnpaddedBytes(r!),
        bigIntToUnpaddedBytes(s!)
      )
    } catch (e: any) {
      const msg = this._errorMsg('Invalid Signature')
      throw new Error(msg)
    }
  }

  toJSON(): JsonTx {
    const accessListJSON = AccessLists.getAccessListJSON(this.accessList)
    const baseJson = super.toJSON()

    return {
      ...baseJson,
      chainId: bigIntToHex(this.chainId),
      maxPriorityFeePerGas: bigIntToHex(this.maxPriorityFeePerGas),
      maxFeePerGas: bigIntToHex(this.maxFeePerGas),
      accessList: accessListJSON,
      maxFeePerDataGas: bigIntToHex(this.maxFeePerDataGas),
      versionedHashes: this.versionedHashes.map((hash) => bytesToPrefixedHexString(hash)),
    }
  }

  _processSignature(v: bigint, r: Uint8Array, s: Uint8Array): BlobEIP4844Transaction {
    const opts = { ...this.txOptions, common: this.common }

    return BlobEIP4844Transaction.fromTxData(
      {
        chainId: this.chainId,
        nonce: this.nonce,
        maxPriorityFeePerGas: this.maxPriorityFeePerGas,
        maxFeePerGas: this.maxFeePerGas,
        gasLimit: this.gasLimit,
        to: this.to,
        value: this.value,
        data: this.data,
        accessList: this.accessList,
        v: v - BigInt(27), // This looks extremely hacky: @ethereumjs/util actually adds 27 to the value, the recovery bit is either 0 or 1.
        r: bytesToBigInt(r),
        s: bytesToBigInt(s),
        maxFeePerDataGas: this.maxFeePerDataGas,
        versionedHashes: this.versionedHashes,
        blobs: this.blobs,
        kzgCommitments: this.kzgCommitments,
        kzgProofs: this.kzgProofs,
      },
      opts
    )
  }
  /**
   * Return a compact error string representation of the object
   */
  public errorStr() {
    let errorStr = this._getSharedErrorPostfix()
    errorStr += ` maxFeePerGas=${this.maxFeePerGas} maxPriorityFeePerGas=${this.maxPriorityFeePerGas}`
    return errorStr
  }

  /**
   * Internal helper function to create an annotated error message
   *
   * @param msg Base error message
   * @hidden
   */
  protected _errorMsg(msg: string) {
    return `${msg} (${this.errorStr()})`
  }

  /**
   * @returns the number of blobs included with this transaction
   */
  public numBlobs() {
    return this.versionedHashes.length
  }
}
