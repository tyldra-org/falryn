# Declaration authoring and interop

Use this reference for handwritten `.d.ts` files, untyped dependencies, global
libraries, module augmentation, and JavaScript packages that publish or consume
types.

## Describe the runtime that exists

A declaration file is a contract for JavaScript behavior. Inspect the runtime
exports, supported module systems, constructor behavior, callbacks, errors, and
side effects before writing types. Do not design a nicer API in the declaration
than the JavaScript actually provides.

Choose the declaration form from how consumers load the value:

- an external module for `import` or `require` entry points;
- a global declaration only when a script truly creates a global value;
- a global-modifying module only when importing it mutates the global scope;
- module augmentation only when an installed module gains real runtime
  behavior elsewhere.

Add `export {}` when a declaration file must remain a module. Unintended global
names can change every file in a program.

## Keep uncertainty visible

Start unknown foreign values as `unknown`, then describe only the behavior the
application has verified. A broad `declare module "package";` turns the entire
dependency into `any` and silences future mistakes. If a temporary declaration
is unavoidable, keep it narrow, name its owner, and add a removal condition.

Use overloads only when callers observe distinct input and output
relationships. Keep the implementation's broad catch-all signature out of the
public declaration. Prefer unions when the return type does not change with the
input.

Do not use optional properties to mean "the declaration author has not checked
this yet." Optionality must match runtime absence.

## Control merging and augmentation

Declaration merging is order- and name-sensitive. Use it for an established
extension contract, not to patch over an import or package-version mismatch.
Keep augmentations beside the integration that installs the runtime behavior
and test that both are loaded together.

Never augment private module paths or generated implementation files. A package
upgrade can move them without changing its public contract.

## Publish consumer-shaped types

- Point each export condition at a declaration file that describes the matching
  runtime artifact.
- Keep public types free of private aliases and inaccessible dependency
  instances.
- Put runtime dependencies and type-only dependencies in the package sections
  needed by a clean consumer.
- Use `typesVersions` only for a real compiler compatibility split that package
  exports cannot express.
- Test ESM and CommonJS consumers only when the package promises both.
- Run declaration emit and install the packed artifact into a clean fixture.

For JavaScript-first packages, prefer checked JSDoc or declaration emit from the
authoritative JavaScript when it produces a stable public contract. Do not keep
handwritten declarations and generated declarations as two authorities.

## Test the declaration

Test accepted imports and calls, deliberate rejected calls, inferred values,
module resolution, and representative runtime execution. A declaration test
that never imports the produced package can miss bad export conditions and
missing files.

Keep `skipLibCheck` as a project-wide performance and compatibility decision.
Do not enable it only to conceal a declaration introduced by the current
change. When it is already enabled, add focused consumer tests for the public
types you own.

## Review checks

- The declaration matches an inspected runtime value and loading style.
- No broad ambient declaration turns a dependency into `any`.
- Globals, merging, and augmentation are deliberate and locally owned.
- Every published entry point has matching runtime and type files.
- A clean consumer proves both type behavior and execution.
- Temporary interop declarations have a named deletion condition.
