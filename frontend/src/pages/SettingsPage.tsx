export default function SettingsPage() {
  return (
    <div>
      <h2 className="text-lg font-semibold text-gray-900 mb-4">Settings</h2>

      <div className="space-y-4">
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-5">
          <h3 className="text-sm font-medium text-gray-700 mb-3">Tenant</h3>
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">Tenant ID</span>
              <span className="font-medium text-gray-900">default</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">Plan</span>
              <span className="font-medium text-gray-900">Pro</span>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-5">
          <h3 className="text-sm font-medium text-gray-700 mb-3">Team Members</h3>
          <p className="text-sm text-gray-400">Member management coming soon.</p>
        </div>
      </div>
    </div>
  );
}
