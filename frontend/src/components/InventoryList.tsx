import React, { useState, useEffect } from 'react';
import axios from 'axios';

interface InventoryItem {
  id: number;
  name: string;
  totalQuantity: number;
  averageCost: number;
  unit: string;
}

const InventoryList: React.FC = () => {
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchItems();
  }, []);

  const fetchItems = async () => {
    try {
      const response = await axios.get('http://localhost:3000/inventory');
      setItems(response.data);
    } catch (error) {
      console.error('Error fetching inventory:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) return <div className="p-6">Carregando estoque...</div>;

  return (
    <div className="p-6">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-2xl font-bold">Estoque</h2>
        <button
          onClick={fetchItems}
          className="bg-gray-200 hover:bg-gray-300 text-gray-800 py-1 px-3 rounded text-sm"
        >
          Atualizar
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full bg-white border border-gray-200">
          <thead>
            <tr className="bg-gray-100">
              <th className="py-2 px-4 border-b text-left">Nome</th>
              <th className="py-2 px-4 border-b text-left">Quantidade</th>
              <th className="py-2 px-4 border-b text-left">Custo Médio</th>
              <th className="py-2 px-4 border-b text-left">Unidade</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td colSpan={4} className="py-4 px-4 text-center text-gray-500">Nenhum item encontrado</td>
              </tr>
            ) : (
              items.map((item) => (
                <tr key={item.id} className="hover:bg-gray-50">
                  <td className="py-2 px-4 border-b">{item.name}</td>
                  <td className="py-2 px-4 border-b">{item.totalQuantity}</td>
                  <td className="py-2 px-4 border-b">R$ {Number(item.averageCost).toFixed(2)}</td>
                  <td className="py-2 px-4 border-b">{item.unit}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default InventoryList;
