"use client";

import { useRef, useState, useTransition, type FormEvent } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { Building2, FileText, PlusCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { createTeam } from "@/actions/groups";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { applyServerFieldErrors } from "@/lib/server-field-errors";
import {
  createTeamFormSchema,
  getCreateTeamFormDefaults,
  type CreateTeamFormValues,
} from "@/lib/validators/team";

export function CreateTeamForm() {
  const router = useRouter();
  const [serverMessage, setServerMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const submitting = useRef(false);

  const form = useForm<CreateTeamFormValues>({
    resolver: zodResolver(createTeamFormSchema),
    defaultValues: getCreateTeamFormDefaults(),
  });

  async function submitTeam(values: CreateTeamFormValues) {
    setServerMessage(null);

    let result: Awaited<ReturnType<typeof createTeam>>;

    try {
      result = await createTeam(values);
    } catch {
      const message =
        "We could not confirm the team creation. Refresh the Teams page before trying again.";
      setServerMessage(message);
      toast.error(message);
      return;
    }

    if (result.status === "error") {
      if (result.fieldErrors) {
        applyServerFieldErrors<CreateTeamFormValues>(
          form.setError,
          result.fieldErrors,
        );
      }

      setServerMessage(result.message);
      toast.error(result.message);
      return;
    }

    toast.success(result.message);
    form.reset(getCreateTeamFormDefaults());

    if (result.teamId) {
      router.push(`/dashboard/${result.teamId}`);
      router.refresh();
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    void form.handleSubmit((values) => {
      if (submitting.current) return;
      submitting.current = true;
      form.clearErrors();
      startTransition(async () => {
        try { await submitTeam(values); }
        finally { submitting.current = false; }
      });
    })(event);
  }

  return (
    <Card className="border-border bg-card">
      <CardHeader className="space-y-2">
        <CardTitle className="text-xl">Create a team</CardTitle>
        <CardDescription className="leading-6">
          Start a new team and become its Owner and first Team Admin. Other users can request
          access from Discover teams.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-5 pb-5 sm:px-6 sm:pb-6">
        <form
          className="space-y-4 sm:space-y-5"
          onSubmit={handleSubmit}
          aria-busy={isPending}
        >
          <div className="space-y-2">
            <Label htmlFor="name">Team name</Label>
            <div className="relative">
              <Building2 className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="name"
                placeholder="Finance Team"
                className="pl-10"
                disabled={isPending}
                aria-invalid={Boolean(form.formState.errors.name)}
                aria-describedby="team-name-help"
                {...form.register("name")}
              />
            </div>
            {form.formState.errors.name ? (
              <p id="team-name-help" role="alert" className="text-sm text-destructive">
                {form.formState.errors.name.message}
              </p>
            ) : (
              <p id="team-name-help" className="text-sm text-muted-foreground">
                Keep the team name short and recognizable for members.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="description">Description</Label>
            <div className="relative">
              <FileText className="pointer-events-none absolute left-3 top-4 h-4 w-4 text-muted-foreground" />
              <Textarea
                id="description"
                rows={4}
                placeholder="What this team ledger is used for"
                className="pl-10"
                disabled={isPending}
                aria-invalid={Boolean(form.formState.errors.description)}
                aria-describedby="team-description-help"
                {...form.register("description")}
              />
            </div>
            {form.formState.errors.description ? (
              <p id="team-description-help" role="alert" className="text-sm text-destructive">
                {form.formState.errors.description.message}
              </p>
            ) : (
              <p id="team-description-help" className="text-sm text-muted-foreground">
                Optional context helps members request the right team.
              </p>
            )}
          </div>

          {serverMessage ? (
            <p role="alert" className="rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
              {serverMessage}
            </p>
          ) : null}

          <Button type="submit" size="lg" className="w-full" disabled={isPending}>
            <PlusCircle className="h-4 w-4" />
            {isPending ? "Creating team..." : "Create team"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
