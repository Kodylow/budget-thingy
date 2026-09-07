import { useMemo, useState } from 'react';
import { Check, Eye, X } from 'lucide-react';
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

export function DevViewChip() {
  const { developmentView } = useAuthContext();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const selectedUser = useMemo(
    () =>
      developmentView.users.find(
        (user) => user.userId === developmentView.selectedId,
      ),
    [developmentView.selectedId, developmentView.users],
  );

  if (!developmentView.enabled) {
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

  return (
    <div className="fixed bottom-4 right-4 z-40 max-w-[calc(100vw-2rem)] sm:bottom-6 sm:right-6">
      <Popover open={open} onOpenChange={setPopoverOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            className="h-11 max-w-full border-amber-500 bg-background px-3 text-amber-700 [border-style:dashed] hover:bg-amber-50 dark:text-amber-300 dark:hover:bg-amber-950"
            aria-label={`Development view as ${selectedUser ? displayName(selectedUser) : 'a user'}`}
            data-testid="dev-view-chip"
          >
            <Eye aria-hidden="true" />
            <span className="truncate">
              DEV: View as{selectedUser ? ` ${displayName(selectedUser)}` : '…'}
            </span>
            <span className="border-l border-amber-500/40 pl-2 text-[10px]">Read-only</span>
          </Button>
        </PopoverTrigger>

        <PopoverContent
          align="end"
          side="top"
          sideOffset={8}
          className="max-h-[var(--radix-popover-content-available-height)] w-[min(24rem,calc(100vw-2rem))] overflow-y-auto p-0"
        >
          <div className="flex items-start justify-between gap-3 border-b px-4 py-3">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold">View as user</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Preview the app with another identity.
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="-mr-2 -mt-1 h-8 min-h-0 w-8"
              onClick={() => setPopoverOpen(false)}
              aria-label="Close view-as menu"
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
                  placeholder="Search name, username, or email"
                  aria-label="Search users"
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

          <div className="border-t bg-muted/40 px-4 py-2.5">
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Eye className="size-3.5" aria-hidden="true" />
              Read-only preview
            </p>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}