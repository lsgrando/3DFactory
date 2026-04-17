import InventoryList from './components/InventoryList'
import InventoryForm from './components/InventoryForm'

function App() {
  return (
    <div className="min-h-screen bg-white text-gray-900">
      <header className="bg-blue-600 text-white p-4 shadow-md">
        <h1 className="text-3xl font-bold">3DFactory ERP</h1>
      </header>
      <main className="container mx-auto py-8">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          <InventoryForm />
          <InventoryList />
        </div>
      </main>
    </div>
  )
}

export default App
