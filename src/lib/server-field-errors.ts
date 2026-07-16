import type {
  FieldPath,
  FieldValues,
  UseFormSetError,
} from "react-hook-form";

export function applyServerFieldErrors<TValues extends FieldValues>(
  setError: UseFormSetError<TValues>,
  fieldErrors: Partial<Record<FieldPath<TValues>, string | undefined>>,
) {
  for (const fieldName of Object.keys(fieldErrors) as FieldPath<TValues>[]) {
    const message = fieldErrors[fieldName];

    if (!message) {
      continue;
    }

    setError(fieldName, {
      type: "server",
      message,
    });
  }
}
