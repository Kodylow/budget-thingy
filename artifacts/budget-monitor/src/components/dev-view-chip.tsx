import React, { useMemo, useState } from 'react';
import { Check, ChevronsUpDown, Eye, Shuffle, X } from 'lucide-react';
import { useAuthContext } from '@/components/auth-context';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';

function displayName(user: {
  userId: string;
  name: string | null;
  username: string | null;
  email: string | null;
}) {
  return user.name || user.username || user.email || user.userId;
}

function DevelopmentViewControl({ signedOut = false }: { signedOut?: boolean }) {
  const { developmentView, isAuthenticated } = useAuthContext();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const selectedUser = useMemo(
    () =>
      developmentView.users.find(
        (user) => user.userId === developmentView.selectedId,
      ),
    [developmentView.selectedId, developmentView.users],
  );

  if (
    !developmentView.enabled ||
    (!signedOut && !isAuthenticated && !developmentView.selectedId)
  ) {
    return null;
  }

  const setPopoverOpen = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      setSearch('');
    }
  };

  const selectUser = (userId: string) => {
    developmentView.select(userId);
    setPopoverOpen(false);
  };

  const selectRandomUser = () => {
    if (!developmentView.users.length) return;
    const choices = developmentView.users.filter(
      user => user.userId !== developmentView.selectedId,
    );
    const users = choices.length ? choices : developmentView.users;
    selectUser(users[Math.floor(Math.random() * users.length)].userId);
  };

  return (
    <div className={signedOut
      ? 'w-full'
      : 'fixed bottom-4 right-4 z-40 max-w-[calc(100vw-2rem)] sm:bottom-6 sm:right-6'}>
      <Popover open={open} onOpenChange={setPopoverOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            className={signedOut
              ? 'h-10 w-full justify-between border-transparent bg-transparent px-3 text-muted-foreground shadow-none hover:bg-muted hover:text-foreground'
              : 'h-10 max-w-full rounded-full border-primary/25 bg-background px-3 text-primary shadow-sm hover:bg-primary/5'}
            aria-label={`Development view as ${selectedUser
              ? displayName(selectedUser)
              : signedOut ? 'someone' : 'a user'}`}
            data-testid="dev-view-chip"
          >
            <Eye aria-hidden="true" />
            <span className="truncate">
              {selectedUser ? `Viewing as ${displayName(selectedUser)}` : 'Preview as someone'}
            </span>
            {signedOut ? <ChevronsUpDown className="size-4 opacity-60" aria-hidden="true" /> : (
              <span className="border-l border-border pl-2 text-[10px] text-muted-foreground">Read-only</span>
            )}
          </Button>
        </PopoverTrigger>

        <PopoverContent
          align="end"
          side="top"
          sideOffset={8}
          className="max-h-[var(--radix-popover-content-available-height)] w-[min(24rem,calc(100vw-2rem))] overflow-y-auto p-0"
        >
          <div className="flex items-center justify-end gap-1 border-b px-2 py-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 min-h-0 gap-1.5 px-2 text-xs text-primary"
                onClick={selectRandomUser}
                disabled={developmentView.loading || developmentView.users.length === 0}
                data-testid="button-random-dev-view"
              >
                <Shuffle className="size-3.5" aria-hidden="true" />
                Random
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="-mr-2 h-8 min-h-0 w-8"
                onClick={() => setPopoverOpen(false)}
                aria-label="Close view-as menu"
                data-testid="button-close-dev-view"
              >
                <X aria-hidden="true" />
              </Button>
          </div>

          {developmentView.error ? (
            <div className="space-y-3 px-4 py-5" role="alert">
              <p className="text-sm font-medium">Couldn’t load users</p>
              <p className="text-sm text-muted-foreground">
                {developmentView.error}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={developmentView.retry}
              >
                Retry
              </Button>
            </div>
          ) : developmentView.loading ? (
            <p
              className="px-4 py-8 text-center text-sm text-muted-foreground"
              role="status"
            >
              Loading users…
            </p>
          ) : (
            <Command>
              <div className="relative">
                <CommandInput
                  value={search}
                  onValueChange={setSearch}
                  placeholder="Search people"
                  aria-label="Search people"
                  data-testid="input-dev-view-search"
                  className="pr-9"
                />
                {search ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="absolute right-1 top-1 h-8 min-h-0 w-8"
                    onClick={() => setSearch('')}
                    aria-label="Clear search"
                  >
                    <X aria-hidden="true" />
                  </Button>
                ) : null}
              </div>
              <CommandList className="max-h-64">
                <CommandEmpty>No matches</CommandEmpty>
                <CommandGroup>
                  {developmentView.users.map((user) => {
                    const isSelected =
                      user.userId === developmentView.selectedId;
                    const secondary = [
                      user.username ? `@${user.username}` : null,
                      user.email,
                    ]
                      .filter(Boolean)
                      .join(' · ');

                    return (
                      <CommandItem
                        key={user.userId}
                        value={[
                          user.name,
                          user.username,
                          user.email,
                          user.userId,
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        onSelect={() => selectUser(user.userId)}
                        className="items-start py-2.5"
                        data-testid={`option-dev-view-${user.userId}`}
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium">
                            {displayName(user)}
                          </p>
                          {secondary ? (
                            <p className="truncate text-xs text-muted-foreground">
                              {secondary}
                            </p>
                          ) : null}
                        </div>
                        <Check
                          aria-hidden="true"
                          className={
                            isSelected ? 'mt-0.5 opacity-100' : 'opacity-0'
                          }
                        />
                        <span className="sr-only">
                          {isSelected ? 'Selected' : ''}
                        </span>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              </CommandList>
            </Command>
          )}

          <div className="flex items-center justify-between gap-3 border-t bg-muted/40 px-4 py-2.5">
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Eye className="size-3.5" aria-hidden="true" />
              Read-only
            </p>
            {developmentView.selectedId ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 min-h-0 text-xs text-primary"
                onClick={() => {
                  developmentView.exit();
                  setPopoverOpen(false);
                }}
                data-testid="button-exit-dev-view"
              >
                Exit preview
              </Button>
            ) : null}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

export function DevViewChip() {
  return <DevelopmentViewControl />;
}

export function DevViewSignedOutPicker() {
  return <DevelopmentViewControl signedOut />;
}