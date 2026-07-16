import Link from "next/link";
import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardTitle } from "@/components/ui/card";

export const metadata = {
  title: "Sign-in unavailable",
};

export default function AuthenticationErrorPage() {
  return (
    <main className="page-shell flex min-h-screen items-center justify-center px-4 py-8">
      <Card className="glass-panel w-full max-w-lg border-white/70 bg-white/90">
        <CardContent className="space-y-6 p-7 sm:p-9">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/12 text-primary">
            <ShieldAlert className="h-6 w-6" aria-hidden="true" />
          </div>
          <div className="space-y-3">
            <CardTitle className="text-2xl">Sign-in could not be completed</CardTitle>
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
