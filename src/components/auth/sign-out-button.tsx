import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { signOut } from "@/lib/auth";

interface SignOutButtonProps {
  className?: string;
  buttonClassName?: string;
}

export function SignOutButton({
  className,
  buttonClassName,
}: SignOutButtonProps) {
  return (
    <form
      action={async () => {
        "use server";

        await signOut({ redirectTo: "/" });
      }}
      className={className}
    >
      <Button type="submit" variant="outline" className={buttonClassName}>
        <LogOut className="h-4 w-4" />
        Sign out
      </Button>
    </form>
  );
}
