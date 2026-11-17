"use client";

import { useFormStatus } from "react-dom";
import { beginReauthentication } from "@/actions/authentication";
import { Button } from "@/components/ui/button";

function Submit() {
  const { pending } = useFormStatus();
  return <Button type="submit" variant="outline" disabled={pending}>{pending ? "Signing out..." : "Sign in again"}</Button>;
}

export function ReauthenticateButton({ returnTo }: { returnTo: string }) {
  return <form data-session-navigation="reauth" action={beginReauthentication.bind(null, returnTo)}><Submit /></form>;
}
