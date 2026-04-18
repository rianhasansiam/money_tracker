import { Button } from "@/components/ui/button";
import { signIn } from "@/lib/auth";

interface GoogleSignInButtonProps {
  redirectTo?: string;
  className?: string;
}

export function GoogleSignInButton({
  redirectTo = "/groups",
  className,
}: GoogleSignInButtonProps) {
  return (
    <form
      action={async () => {
        "use server";

        await signIn("google", { redirectTo });
      }}
      className={className}
    >
      <Button type="submit" size="lg" className="w-full justify-center">
        <GoogleMark />
        Continue with Google
      </Button>
    </form>
  );
}

function GoogleMark() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="h-4 w-4"
      fill="none"
    >
      <path
        d="M21.805 12.23c0-.79-.071-1.55-.203-2.28H12v4.314h5.49a4.697 4.697 0 0 1-2.037 3.083v2.558h3.292c1.926-1.773 3.06-4.386 3.06-7.675Z"
        fill="#4285F4"
      />
      <path
        d="M12 22c2.756 0 5.067-.913 6.756-2.476l-3.292-2.558c-.914.612-2.082.975-3.464.975-2.657 0-4.908-1.794-5.712-4.206H2.89v2.638A9.998 9.998 0 0 0 12 22Z"
        fill="#34A853"
      />
      <path
        d="M6.288 13.735A5.985 5.985 0 0 1 5.969 12c0-.602.11-1.185.319-1.735V7.627H2.89A9.997 9.997 0 0 0 2 12c0 1.61.384 3.13 1.07 4.373l3.218-2.638Z"
        fill="#FBBC04"
      />
      <path
        d="M12 6.06c1.5 0 2.847.516 3.91 1.53l2.932-2.933C17.062 2.999 14.75 2 12 2A9.998 9.998 0 0 0 2.89 7.627l3.398 2.638C7.092 7.853 9.343 6.06 12 6.06Z"
        fill="#EA4335"
      />
    </svg>
  );
}
