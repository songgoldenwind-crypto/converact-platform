import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './hooks/useAuth';
import DashboardLayout from './layouts/DashboardLayout';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import CallRecordsPage from './pages/CallRecordsPage';
import QmDashboardPage from './pages/QmDashboardPage';
import AgentSeatsPage from './pages/AgentSeatsPage';
import AgentWorkbenchPage from './pages/AgentWorkbenchPage';
import SettingsPage from './pages/SettingsPage';
import SpecEditorPage from './pages/SpecEditorPage';
import OutboundTaskPage from './pages/OutboundTaskPage';
import QueuesPage from './pages/QueuesPage';
import DidNumbersPage from './pages/DidNumbersPage';
import WallboardPage from './pages/WallboardPage';
import KnowledgePage from './pages/KnowledgePage';
import RecordingsPage from './pages/RecordingsPage';
import VoicemailsPage from './pages/VoicemailsPage';
import CampaignPage from './pages/CampaignPage';
import WfmSchedulePage from './pages/WfmSchedulePage';
import UnifiedInboxPage from './pages/UnifiedInboxPage';
import VideoCallPage from './pages/VideoCallPage';
import RemoteAssistPage from './pages/RemoteAssistPage';
import RemoteAssistObserverPage from './pages/RemoteAssistObserverPage';
import CollaborationChatPage from './pages/CollaborationChatPage';
import DeveloperPage from './pages/DeveloperPage';
import CustomerJourneyPage from './pages/CustomerJourneyPage';
import CompliancePage from './pages/CompliancePage';
import WhiteLabelPage from './pages/WhiteLabelPage';
import CustomDashboardPage from './pages/CustomDashboardPage';
import ProactivePushPage from './pages/ProactivePushPage';
import IntelligencePage from './pages/IntelligencePage';
import IvrMarketplacePage from './pages/IvrMarketplacePage';
import IvrDesignerPage from './ivr/IvrDesignerPage';
import IvrFlowListPage from './ivr/IvrFlowListPage';
import IvrSettingsPage from './ivr/IvrSettingsPage';
import IvrAudioLibraryPage from './ivr/IvrAudioLibraryPage';
import IvrMonitorPage from './ivr/IvrMonitorPage';
import ScreenRecordingsPage from './pages/ScreenRecordingsPage';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuth();
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/video" element={<VideoCallPage />} />
      <Route path="/remote-assist/session" element={<RemoteAssistPage />} />
      <Route
        element={
          <ProtectedRoute>
            <DashboardLayout />
          </ProtectedRoute>
        }
      >
        <Route path="/" element={<DashboardPage />} />
        <Route path="/specs" element={<SpecEditorPage />} />
        <Route path="/outbound" element={<OutboundTaskPage />} />
        <Route path="/campaigns" element={<CampaignPage />} />
        <Route path="/wfm" element={<WfmSchedulePage />} />
        <Route path="/inbox" element={<UnifiedInboxPage />} />
        <Route path="/journey" element={<CustomerJourneyPage />} />
        <Route path="/developer" element={<DeveloperPage />} />
        <Route path="/compliance" element={<CompliancePage />} />
        <Route path="/white-label" element={<WhiteLabelPage />} />
        <Route path="/dashboard-custom" element={<CustomDashboardPage />} />
        <Route path="/proactive-push" element={<ProactivePushPage />} />
        <Route path="/intelligence" element={<IntelligencePage />} />
        <Route path="/ivr-marketplace" element={<IvrMarketplacePage />} />
        <Route path="/ivr-flows" element={<IvrFlowListPage />} />
        <Route path="/ivr-designer" element={<IvrDesignerPage />} />
        <Route path="/ivr-settings" element={<IvrSettingsPage />} />
        <Route path="/ivr-audio-library" element={<IvrAudioLibraryPage />} />
        <Route path="/ivr-monitor" element={<IvrMonitorPage />} />
        <Route path="/screen-recordings" element={<ScreenRecordingsPage />} />
        <Route path="/remote-assist/observe" element={<RemoteAssistObserverPage />} />
        <Route path="/collaboration/chat" element={<CollaborationChatPage />} />
        <Route path="/queues" element={<QueuesPage />} />
        <Route path="/did-numbers" element={<DidNumbersPage />} />
        <Route path="/wallboard" element={<WallboardPage />} />
        <Route path="/knowledge" element={<KnowledgePage />} />
        <Route path="/recordings" element={<RecordingsPage />} />
        <Route path="/voicemails" element={<VoicemailsPage />} />
        <Route path="/calls" element={<CallRecordsPage />} />
        <Route path="/qm" element={<QmDashboardPage />} />
        <Route path="/agents" element={<AgentSeatsPage />} />
        <Route path="/workbench" element={<AgentWorkbenchPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Route>
    </Routes>
  );
}
