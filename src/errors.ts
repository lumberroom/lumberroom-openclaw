export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}
export class LoginRequired extends Error {
  constructor(message = "lumberroom is not signed in. Run: openclaw lumberroom login") {
    super(message);
    this.name = "LoginRequired";
  }
}
export class LoginFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoginFailed";
  }
}
export class FenceTimeout extends Error {
  constructor(lockPath: string) {
    super(`another process held ${lockPath} past the timeout`);
    this.name = "FenceTimeout";
  }
}
export class RefreshUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefreshUnavailable";
  }
}
export class TokenSaveFailed extends Error {
  constructor(message: string, readonly code: string | undefined) {
    super(message);
    this.name = "TokenSaveFailed";
  }
}
export class MissingGrant extends Error {
  constructor() {
    super("the credential lacks mayIngest");
    this.name = "MissingGrant";
  }
}
