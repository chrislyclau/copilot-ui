# TYPESCRIPT STYLE GUIDE (STRICT LIGHTWEIGHT)

You are a strict TypeScript code generator. Prioritize complete compile-time safety and prevent runtime crashes. Follow these exact patterns.

## 1. No Escape Hatches & Null Discipline

* Never use `any`, `as any`, `@ts-ignore`, or `@ts-expect-error`.
* If a type is unknown, use `unknown` and narrow it immediately using `typeof` or `instanceof`.
* Prefer `T | undefined` over `T | null`. Never mix both. Never use the generic `Function` or `{}` types.

## 2. Arguments & Key-Value Maps

* **Multi-Param Rule:** Use a single object argument if a function takes **3+ parameters** OR **2+ parameters of the same type** (prevents positional mixing bugs).
* **Dynamic Keys:** For truly dynamic runtime keys, you MUST use `Record<string, T | undefined>`. This forces compile-time safety checks when reading values.
```typescript
// DO NOT DO: const genericMap: Record<string, User>
// ALWAYS DO:  const genericMap: Record<string, User | undefined>

```



## 3. Strict Domain IDs (Branding)

Do not use raw strings/numbers for functional IDs. Use this exact pattern and helper:

```typescript
type Brand<K, T> = K & { readonly __brand: T };
type UserId = Brand<string, 'UserId'>;
export const toUserId = (id: string): UserId => id as UserId;

```

## 4. Deep Immutability

* Every interface, type, and class property must be `readonly`.
* **Deep Readonly:** Nested objects must also explicitly be marked `readonly`.
```typescript
// BAD:  readonly options: { timeout: number };
// GOOD: readonly options: { readonly timeout: number };

```


* Never use `T[]`. Always use `ReadonlyArray<T>` or `readonly T[]`.

## 5. Safe Operations & Exhaustiveness

* Never throw runtime errors for predictable failures. Return a `Result` union and narrow immediately:
```typescript
type Result<T, E = Error> = | { readonly success: true; readonly data: T } | { readonly success: false; readonly error: E };

```


* **Exhaustiveness Check:** Every `switch` or `if/else` over a union type must include a fallback to `assertNever` to guarantee compile-time coverage:
```typescript
function assertNever(x: never): never { throw new Error(`Unhandled case: ${x}`); }

```



## 6. Boundary Validation (Zod)

All external payloads (API responses, JSON strings) are untrusted. You MUST validate them at the **exact module entry point** using Zod, converting errors directly into a Rule 5 `Result`.

```typescript
import { z } from 'zod';
const UserSchema = z.object({ id: z.string(), age: z.number() });

function parseUserInbound(externalData: unknown): Result<z.infer<typeof UserSchema>> {
  const parsed = UserSchema.safeParse(externalData);
  if (!parsed.success) {
    return { success: false, error: parsed.error }; // Explicit Rule 5 pipeline integration
  }
  return { success: true, data: parsed.data };
}

```

