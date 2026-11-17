import Link from "next/link";
import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription } from "@/components/ui/card";

export const metadata = {
  title: "Sign-in unavailable",
};

export default function AuthenticationErrorPage() {
  return (
    <main className="page-shell flex min-h-screen items-center justify-center px-4 py-8">
      <Card className="w-full max-w-lg border-border bg-card">
        <CardContent className="space-y-6 p-7 sm:p-8">
          <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary/12 text-primary">
            <ShieldAlert className="h-6 w-6" aria-hidden="true" />
          </div>
          <div className="space-y-3">
            <h1 className="text-2xl font-semibold">Sign-in could not be completed</h1>
            <CardDescription className="text-sm leading-6">
              Access may be unavailable or the sign-in request may have expired.
              If you should have access, contact an administrator and try again.
            </CardDescription>
          </div>
          <Button asChild>
            <Link href="/login">Return to sign in</Link>
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
