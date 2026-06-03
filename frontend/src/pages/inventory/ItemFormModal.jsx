import { Modal } from '@/components/ui'
import ItemFormFields from './ItemFormFields'

/** Edit item modal — create flow lives on /item-master/new. */
export default function ItemFormModal({
  open, onClose, editing, editWasTracked, form, patchForm, onSave, categories, taxRates = [],
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Edit Item"
      icon="📦"
      size="lg"
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={onSave}>Update Item</button>
        </>
      }
    >
      <ItemFormFields
        form={form}
        patchForm={patchForm}
        categories={categories}
        taxRates={taxRates}
        editing={editing}
        editWasTracked={editWasTracked}
      />
    </Modal>
  )
}
