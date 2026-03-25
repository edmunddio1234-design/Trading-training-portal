import React, { useState, useEffect } from 'react';
import { Client } from '../../types';
import { TRACKER_MODULES, FULL_SCHEDULE_LOG, CLASS_LOCATION } from '../../constants';
import { Lock, LogOut, MapPin, Target, Check, Calendar, ChevronRight, Edit2, Save, X, RefreshCw } from 'lucide-react';
import { clientApi } from '../../services/fatherhoodApi';

interface ClientPortalProps {
  client?: Client | null;
  clients: Client[];
  modules?: any[];
  onBack?: () => void;
  onSelectClient?: (id: string) => void;
  onUpdateClient?: (client: Client) => void;
}

// Status options
const STATUS_OPTIONS: Client['status'][] = ['Active', 'At Risk', 'Graduated', 'Inactive'];

export const ClientPortal: React.FC<ClientPortalProps> = ({ client, clients, onBack, onSelectClient, onUpdateClient }) => {
  const [accessId, setAccessId] = useState('');
  const [currentUser, setCurrentUser] = useState<Client | null>(client || null);
  const [error, setError] = useState('');

  // If a client is passed in (e.g. from Roster click), use it directly
  useEffect(() => {
    if (client) {
      setCurrentUser(client);
    }
  }, [client]);

  // NEW: Status editing state
  const [isEditingStatus, setIsEditingStatus] = useState(false);
  const [newStatus, setNewStatus] = useState<Client['status']>('Active');
  const [saving, setSaving] = useState(false);

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    const user = clients.find(f => f.id.toLowerCase() === accessId.toLowerCase());
    if (user) {
      setCurrentUser(user);
      setError('');
    } else {
      setError('Invalid Participant ID.');
    }
  };

  // Find the next incomplete module for a client
  const getNextModule = (completedModules: number[]) => {
    const completedSet = new Set(completedModules);
    for (const module of TRACKER_MODULES) {
      if (!completedSet.has(module.id)) {
        return module;
      }
    }
    return null;
  };

  // Get the next scheduled session for a specific module
  const getNextSessionForModule = (moduleId: number) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (const session of FULL_SCHEDULE_LOG) {
      const sessionDate = new Date(session.date + 'T12:00:00');
      if (sessionDate >= today && session.moduleId === moduleId) {
        return session;
      }
    }
    return null;
  };

  // Format date for display
  const formatSessionDate = (dateString: string) => {
    const date = new Date(dateString + 'T12:00:00');
    return date.toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric'
    });
  };

  // NEW: Save status change
  const handleSaveStatus = async () => {
    if (!currentUser) return;
    setSaving(true);
    try {
      const updatedClient = await clientApi.updateClient(currentUser.id, { status: newStatus });
      if (updatedClient) {
        setCurrentUser(updatedClient);
        if (onUpdateClient) onUpdateClient(updatedClient);
      }
      setIsEditingStatus(false);
    } catch (error) {
      console.error('Error updating status:', error);
    } finally {
      setSaving(false);
    }
  };

  // NEW: Get status color
  const getStatusColor = (status: Client['status']) => {
    switch (status) {
      case 'Active': return 'bg-emerald-100 text-emerald-700';
      case 'At Risk': return 'bg-amber-100 text-amber-700';
      case 'Graduated': return 'bg-blue-100 text-blue-700';
      case 'Inactive': return 'bg-slate-100 text-slate-500';
      default: return 'bg-slate-100 text-slate-500';
    }
  };

  if (!currentUser) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh] animate-in fade-in duration-500">
        <div className="bg-white p-12 rounded-[3rem] border border-slate-100 shadow-2xl max-w-md w-full text-center space-y-8">
            <div className="w-20 h-20 bg-blue-50 text-blue-600 rounded-full flex items-center justify-center mx-auto shadow-inner"><Lock size={32}/></div>
            <div className="space-y-2">
                <h2 className="text-3xl font-black text-slate-800">Participant Portal</h2>
                <p className="text-slate-500 font-medium">Verify your program progress</p>
            </div>
            <form onSubmit={handleLogin} className="space-y-4">
                <input type="text" placeholder="ID Number" value={accessId} onChange={e => setAccessId(e.target.value)} className="w-full p-5 bg-slate-50 border-2 border-slate-50 rounded-2xl text-center text-3xl font-mono focus:border-blue-500 outline-none transition-all" />
                {error && <p className="text-xs font-black text-rose-600 uppercase tracking-widest">{error}</p>}
                <button type="submit" className="w-full py-5 bg-blue-600 text-white rounded-2xl font-black uppercase tracking-widest text-xs hover:bg-slate-800 transition-all shadow-xl">Authenticate Access</button>
            </form>
        </div>
      </div>
    );
  }

  const completedSet = new Set(currentUser.completedModules);
  const progress = Math.round((completedSet.size / 14) * 100);
  const nextModule = getNextModule(currentUser.completedModules);
  const nextSession = nextModule ? getNextSessionForModule(nextModule.id) : null;
  const hasGraduated = completedSet.size >= 14;

  return (
    <div className="animate-in fade-in duration-500 space-y-10">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-6">
        <div>
          <span className="bg-blue-50 text-blue-600 text-[10px] font-black uppercase tracking-[0.2em] px-3 py-1 rounded-full mb-3 inline-block">Active Client</span>
          <h2 className="text-4xl font-black text-slate-800 leading-tight">Welcome back,<br/>{currentUser.firstName} {currentUser.lastName}</h2>
          <div className="flex items-center gap-6 mt-4 text-xs font-bold text-slate-400 uppercase tracking-widest">
             <span className="flex items-center gap-2"><Target size={14} className="text-blue-500"/> ID: #{currentUser.id}</span>
             <span className="flex items-center gap-2"><MapPin size={14} className="text-rose-500"/> {CLASS_LOCATION.name}</span>
          </div>
          {/* NEW: Editable status display */}
          <div className="flex items-center gap-3 mt-4">
            <span className={`inline-flex px-3 py-1 rounded-full text-xs font-black uppercase tracking-widest ${getStatusColor(currentUser.status)}`}>
              {currentUser.status}
            </span>
            <button
              onClick={() => { setNewStatus(currentUser.status); setIsEditingStatus(true); }}
              className="text-xs text-blue-600 hover:text-blue-800 font-bold flex items-center gap-1"
            >
              <Edit2 size={12} /> Edit
            </button>
          </div>
        </div>
        <button onClick={() => { setCurrentUser(null); if (client && onBack) onBack(); }} className="px-6 py-3 bg-white border border-slate-200 text-slate-400 rounded-xl font-bold text-xs uppercase tracking-widest hover:text-rose-500 transition-colors flex items-center gap-2"><LogOut size={16}/> {client ? 'Back to Roster' : 'Sign Out'}</button>
      </div>

      {/* NEW: Status Edit Modal */}
      {isEditingStatus && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl p-6 max-w-sm w-full shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-black text-slate-800">Edit Status</h3>
              <button onClick={() => setIsEditingStatus(false)} className="p-1 hover:bg-slate-100 rounded">
                <X size={20} className="text-slate-400" />
              </button>
            </div>
            <select
              value={newStatus}
              onChange={(e) => setNewStatus(e.target.value as Client['status'])}
              className="w-full p-3 border-2 border-slate-200 rounded-xl text-sm font-bold focus:border-blue-500 outline-none mb-4"
            >
              {STATUS_OPTIONS.map(status => (
                <option key={status} value={status}>{status}</option>
              ))}
            </select>
            <div className="flex gap-2">
              <button onClick={() => setIsEditingStatus(false)} className="flex-1 py-3 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl font-bold text-sm">
                Cancel
              </button>
              <button
                onClick={handleSaveStatus}
                disabled={saving || newStatus === currentUser.status}
                className={`flex-1 py-3 rounded-xl font-bold text-sm flex items-center justify-center gap-2 ${
                  saving || newStatus === currentUser.status ? 'bg-slate-200 text-slate-400' : 'bg-blue-600 hover:bg-blue-700 text-white'
                }`}
              >
                {saving ? <RefreshCw size={16} className="animate-spin" /> : <Save size={16} />}
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        <div className="lg:col-span-8 bg-white p-10 rounded-[3rem] border border-slate-100 shadow-xl flex flex-col md:flex-row items-center gap-12">
            <div className="flex-1 space-y-6">
                <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest">Aggregate Completion</h3>
                <div className="flex items-baseline gap-3">
                    <span className="text-7xl font-black text-slate-800">{progress}%</span>
                    <span className="text-lg font-black text-blue-600 uppercase">Tracked Success</span>
                </div>
                <div className="w-full h-3 bg-slate-50 rounded-full overflow-hidden border border-slate-100 shadow-inner">
                    <div className="h-full bg-blue-500 transition-all duration-1000" style={{ width: `${progress}%` }}></div>
                </div>
            </div>
            <div className="w-48 h-48 bg-slate-50 rounded-full border-4 border-white shadow-inner flex items-center justify-center relative">
                <div className="text-center">
                    <p className="text-4xl font-black text-slate-800">{currentUser.completedModules.length}</p>
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Verified Classes</p>
                </div>
            </div>
        </div>

        <div className={`lg:col-span-4 ${hasGraduated ? 'bg-emerald-700' : 'bg-slate-900'} text-white rounded-[3rem] p-10 shadow-2xl flex flex-col justify-between border-b-8 ${hasGraduated ? 'border-emerald-400' : 'border-blue-600'}`}>
            <div className="space-y-4">
                <span className="px-3 py-1 bg-white/10 text-white text-[10px] font-black uppercase tracking-widest rounded-full">
                  {hasGraduated ? '🎓 Congratulations!' : 'Next Milestone'}
                </span>
                <p className={`text-xs ${hasGraduated ? 'text-emerald-300' : 'text-blue-400'} font-bold uppercase tracking-widest`}>
                  {hasGraduated ? 'Program Complete' : 'Required Curriculum'}
                </p>
                <h3 className="text-2xl font-black leading-tight">
                  {hasGraduated
                    ? 'You Have Graduated!'
                    : nextModule
                      ? `Module ${nextModule.id}: ${nextModule.title}`
                      : 'All Modules Complete'
                  }
                </h3>
                {nextModule && !hasGraduated && (
                  <p className="text-xs text-slate-400 mt-2">
                    Category: {nextModule.category}
                  </p>
                )}
            </div>
            <div className="mt-8 p-6 bg-white/5 border border-white/10 rounded-2xl">
                <p className={`text-[10px] ${hasGraduated ? 'text-emerald-300' : 'text-blue-400'} font-black uppercase tracking-widest mb-1`}>
                  {hasGraduated ? 'Achievement Unlocked' : 'Upcoming Session'}
                </p>
                {hasGraduated ? (
                  <>
                    <p className="text-lg font-black">Program Graduate</p>
                    <p className="text-xs font-medium text-slate-400 mt-1">14/14 Modules Completed</p>
                  </>
                ) : nextSession ? (
                  <>
                    <p className="text-lg font-black">{formatSessionDate(nextSession.date)}</p>
                    <p className="text-xs font-medium text-slate-400 mt-1">@ {nextSession.time} CST</p>
                  </>
                ) : (
                  <>
                    <p className="text-lg font-black">Check Schedule</p>
                    <p className="text-xs font-medium text-slate-400 mt-1">Contact your case manager</p>
                  </>
                )}
            </div>
        </div>
      </div>

      <div className="bg-white rounded-[3rem] border border-slate-100 shadow-xl overflow-hidden">
          <div className="p-8 border-b bg-slate-50/50">
              <h3 className="text-xl font-black text-slate-800 tracking-tight">Personal Graduation Pathway</h3>
          </div>
          <div className="overflow-x-auto">
              <table className="w-full text-left">
                  <thead>
                      <tr className="bg-slate-50 text-[10px] font-black text-slate-400 uppercase tracking-widest border-b border-slate-100">
                          <th className="px-8 py-5">Module</th>
                          <th className="px-8 py-5">Registry Topic</th>
                          <th className="px-8 py-5">Status</th>
                      </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                      {TRACKER_MODULES.map(m => {
                          const isDone = completedSet.has(m.id);
                          const isNext = nextModule && m.id === nextModule.id;
                          return (
                              <tr key={m.id} className={`${isDone ? 'bg-emerald-50/20' : isNext ? 'bg-blue-50/30' : ''}`}>
                                  <td className="px-8 py-6">
                                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center font-black text-xs ${
                                      isDone ? 'bg-emerald-500 text-white' :
                                      isNext ? 'bg-blue-500 text-white' :
                                      'bg-slate-100 text-slate-400'
                                    }`}>
                                      {m.id}
                                    </div>
                                  </td>
                                  <td className="px-8 py-6">
                                      <p className={`font-black text-sm ${isDone ? 'text-slate-400 line-through' : isNext ? 'text-blue-700' : 'text-slate-800'}`}>
                                        {m.title}
                                      </p>
                                      {isNext && (
                                        <span className="text-[9px] font-bold text-blue-500 uppercase tracking-widest">← Up Next</span>
                                      )}
                                  </td>
                                  <td className="px-8 py-6">
                                      {isDone ? (
                                          <span className="inline-flex items-center gap-2 px-3 py-1 bg-emerald-100 text-emerald-700 rounded-full text-[9px] font-black uppercase tracking-widest"><Check size={12}/> Verified</span>
                                      ) : isNext ? (
                                          <span className="inline-flex items-center gap-2 px-3 py-1 bg-blue-100 text-blue-700 rounded-full text-[9px] font-black uppercase tracking-widest">
                                            <Calendar size={12}/> Next Class
                                          </span>
                                      ) : (
                                          <span className="text-[9px] font-black text-slate-300 uppercase tracking-widest">Enrolled</span>
                                      )}
                                  </td>
                              </tr>
                          );
                      })}
                  </tbody>
              </table>
          </div>
      </div>
    </div>
  );
};
