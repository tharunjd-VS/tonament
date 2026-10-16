'use strict';

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code; // optional machine-readable reason, e.g. 'stale'
  }
}

module.exports = { HttpError };
