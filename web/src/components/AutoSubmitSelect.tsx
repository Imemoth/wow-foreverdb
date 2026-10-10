"use client";

/**
 * Progressive enhancement: filters are a plain GET form (works without JS and
 * keeps state in the URL so Back/Forward behave). With JS, changing a select
 * submits immediately.
 */
export function AutoSubmitSelect(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      onChange={(e) => {
        e.currentTarget.form?.requestSubmit();
      }}
    />
  );
}
