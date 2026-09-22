const messages = {
  invalidCredentials: "Неверный email или пароль",
  databaseUnavailable: "Сервис временно недоступен. Попробуйте позже",
  invalidEmail: "Введите корректный email",
  passwordLength: "Пароль должен содержать от 8 до 128 символов",
  accountExists: "Аккаунт с таким email уже существует",
} as const;

export type AuthErrorCode = keyof typeof messages;

export function isAuthErrorCode(value: unknown): value is AuthErrorCode {
  return typeof value === "string" && Object.hasOwn(messages, value);
}

export function authError(code: AuthErrorCode) {
  return { code, error: messages[code] };
}
