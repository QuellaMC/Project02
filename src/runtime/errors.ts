export class ContractValidationError extends Error {
  readonly code: string;

  constructor(message: string, code = 'invalid_contract') {
    super(message);
    this.name = 'ContractValidationError';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
