import { Fragment } from "react";

const TOKEN =
  /((?:GET|POST|PUT|PATCH|DELETE)\s+\/[^\s،]+|\/[A-Za-z0-9_./{}:-]+|\b[A-Z][A-Z0-9]*-\d+\b|\b(?:SELECT|INSERT|UPDATE|DELETE)\b[^،\n]{0,80})/g;

export function BidiText({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const persian = /[\u0600-\u06FF]/.test(text);
  const parts = text.split(TOKEN);
  return (
    <span
      dir={persian ? "rtl" : "ltr"}
      className={className}
      style={{ textAlign: persian ? "right" : "left" }}
    >
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <bdi key={`${part}-${index}`} dir="ltr" className="dir-ltr font-mono">
            {part}
          </bdi>
        ) : (
          <Fragment key={`${part}-${index}`}>{part}</Fragment>
        ),
      )}
    </span>
  );
}
