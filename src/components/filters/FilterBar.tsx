import React from 'react';
import { Search } from 'lucide-react';
import { CopilotEvent } from '../../mockEvents';

interface FilterBarProps {
  readonly searchQuery: string;
  readonly setSearchQuery: (query: string) => void;
  readonly expandAll: () => void;
  readonly collapseAll: () => void;
  readonly selectedCategory: string;
  readonly setSelectedCategory: (cat: string) => void;
  readonly events: readonly CopilotEvent[];
}

export function FilterBar({
  searchQuery,
  setSearchQuery,
  expandAll,
  collapseAll,
  selectedCategory,
  setSelectedCategory,
  events,
}: FilterBarProps) {
  const categories = [
    { id: 'all', label: 'All Items', count: events.length },
    { id: 'user', label: 'User Prompts', count: events.filter(e => e.category === 'user').length },
    { id: 'assistant', label: 'Model Outputs', count: events.filter(e => e.category === 'assistant').length },
    { id: 'tool', label: 'Tool Calls', count: events.filter(e => e.category === 'tool').length },
    { id: 'permission', label: 'Permissions', count: events.filter(e => e.category === 'permission').length },
    { id: 'error', label: 'Errors', count: events.filter(e => e.category === 'error').length },
    { id: 'system', label: 'System', count: events.filter(e => e.category === 'system').length },
  ];

  return (
    <div className="bg-transparent border-b border-zinc-200 dark:border-zinc-800/80 py-3 mb-2 flex flex-col gap-3">
      <div className="flex flex-col md:flex-row md:items-center gap-3">
        
        {/* Text Search inside payloads */}
        <div className="relative grow">
          <Search size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-500 dark:text-zinc-400" />
          <input
            id="search-input"
            type="text"
            placeholder="Filter through event scopes, parameters, raw response text..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-700 focus:border-sky-505 focus:ring-1 focus:ring-sky-505 rounded-xl pl-10 pr-4 py-2 text-sm transition-all text-zinc-805 dark:text-zinc-100 focus:outline-none"
          />
        </div>

        {/* Expansion helper triggers */}
        <div className="flex items-center gap-1.5 shrink-0 self-end md:self-auto">
          <button
            id="btn-expand-all"
            onClick={expandAll}
            className="px-3 py-1.5 bg-zinc-50 hover:bg-zinc-100 dark:bg-zinc-850 dark:hover:bg-zinc-800 border border-zinc-200 dark:border-zinc-750 rounded-lg text-xs font-semibold text-zinc-700 dark:text-zinc-300 transition-colors cursor-pointer font-sans"
          >
            Expand All
          </button>
          <button
            id="btn-collapse-all"
            onClick={collapseAll}
            className="px-3 py-1.5 bg-zinc-50 hover:bg-zinc-100 dark:bg-zinc-850 dark:hover:bg-zinc-800 border border-zinc-200 dark:border-zinc-750 rounded-lg text-xs font-semibold text-zinc-700 dark:text-zinc-300 transition-colors cursor-pointer font-sans"
          >
            Collapse Clutter
          </button>
        </div>
      </div>

      {/* Category selection items */}
      <div className="flex items-center gap-4 overflow-x-auto pb-1 scrollbar-none font-sans text-xs">
        {categories.map(pill => (
          <button
            key={pill.id}
            id={`tab-category-${pill.id}`}
            onClick={() => setSelectedCategory(pill.id)}
            className={`whitespace-nowrap transition-all uppercase tracking-wider flex items-center cursor-pointer font-sans font-medium text-[11px] ${
              selectedCategory === pill.id 
                ? 'text-sky-500 font-bold dark:text-sky-400 border-b-2 border-sky-500 dark:border-sky-400 pb-0.5' 
                : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-300 pb-0.5'
            }`}
          >
            <span>{pill.label} ({pill.count})</span>
          </button>
        ))}
      </div>
    </div>
  );
}
